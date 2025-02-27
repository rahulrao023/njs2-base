const path = require("path");
const fs = require("fs");

// TODO: revisit global imports
baseInitialize = require('./baseInitialize.class');
baseAction = require("./baseAction.class");
basePkg = require("./basePackage.class");
globalMethods = require("../helper/globalMethods");

const baseHelper = require("../helper/baseHelper.class");
const ParameterProcessor = require('./parameterProcessor.class');
const { encrypt, decrypt } = require('../helper/encryption');
const { ENC_MODE, DEFAULT_LNG_KEY, ENC_ENABLED } = require('../helper/globalConstants');
const jwt = require('../helper/jwt');
const _ = require("lodash");
const multiReplace = require('string-multiple-replace');

class executor {
  constructor() {
    this.responseData = {};
  }

  async executeRequest(request) {
    try {
      this.setResponse('UNKNOWN_ERROR');
      
      // Property finding factory
      const findPropInRequest = baseHelper.deepFindPropMaker(request)
      
      // Find the basic variables from the incoming request
      // Initializng basic variables
      const lngKey = findPropInRequest("lng_key")
      const encState = findPropInRequest("enc_state")
      const accessToken = findPropInRequest("access_token")

      // Decide encryption mode. And enforce enc_state to be true if encryption is Strict
      const { ENCRYPTION_MODE } = JSON.parse(process.env.ENCRYPTION);
      if (ENCRYPTION_MODE == ENC_MODE.STRICT && encState != ENC_ENABLED) {
        this.setResponse('ENCRYPTION_STATE_STRICTLY_ENABLED');
        throw new Error();
      }
      const encryptionState = (ENCRYPTION_MODE == ENC_MODE.STRICT || (ENCRYPTION_MODE == ENC_MODE.OPTIONAL && encState == ENC_ENABLED));
      
      // Set member variables
      this.setMemberVariable('encryptionState', this.encryptionState);
      if (lngKey) this.setMemberVariable('lng_key', lngKey);

      // Finalize methodName including custom route
      let methodName = baseHelper.getMethodName(request.pathParameters);
      request.pathParameters = null;
      const { customMethodName, pathParameters } = baseHelper.getCustomRoute(methodName);
      if (customMethodName) {
        request.pathParameters = pathParameters;
        methodName = customMethodName;
      }

      // Resolve path from methodName
      const pathName = baseHelper.getMethodPath(methodName);
      const methodClasses = baseHelper.getMethodClasses(pathName);
      if (methodClasses.error) {
        this.setResponse('METHOD_NOT_LOADED');
        throw new Error(methodClasses.error);
      }

      // Include required files and initiate instances
      const { action: ActionClass, init: InitClass } = methodClasses;
      const initInstance = new InitClass();
      const actionInstance = new ActionClass();
      if (lngKey) {
        actionInstance.setMemberVariable('lng_key', lngKey);
      }

      // Validate request method with initializer
      if (!baseHelper.isValidRequestMethod(request.httpMethod, initInstance.initializer.requestMethod)) {
        this.setResponse('INVALID_REQUEST_METHOD');
        throw new Error();
      }

      // if secured endpoint validate access token
      if (initInstance.initializer.isSecured) {
        const { error, data } = await this.validateAccesstoken(accessToken);
        if (error) {
          this.setResponse(error.errorCode, {
            paramName: error.parameterName
          });
          throw new Error(error.errorCode+' : '+error.parameterName);
        }
        actionInstance.setMemberVariable('userObj', data);
      }

      // Parse the incoming request object and find if the metadata configs are present
      // if present, group them under metadata key and make it action instance member
      const metaConfig = process.env["METADATA"];
      if(metaConfig && baseHelper.isJSON(metaConfig)) {
        const metadata = baseHelper.populateMetadata(request, JSON.parse(metaConfig));
        actionInstance.setMemberVariable('metadata', metadata);
      }

      // validate & process request parameters
      const parameterProcessor = new ParameterProcessor();
      const params = initInstance.getParameter();
      const isFileExpected = baseHelper.isFileExpected(params);
      let requestData = baseHelper.parseRequestData(request, isFileExpected);

      // If encyption is enabled, then decrypt the request data
      if (!isFileExpected &&this.encryptionState) {
        requestData = decrypt(requestData.data);
        if (typeof requestData === 'string')
          requestData = JSON.parse(requestData);
      }
      requestData = requestData ? requestData : {};

      // Proccess and validate each parameters and set it as member variable
      for (let paramName in params) {
        let param = params[paramName];
        const parsedData = await parameterProcessor.processParameter(requestData[param.name]);
        const { error, value } = parameterProcessor.validateParameters(param, parsedData);
        if (error) {
          this.setResponse(error.errorCode, {
            paramName: error.parameterName
          });
          throw new Error(error.errorCode+' : '+error.parameterName)
        }
        actionInstance.setMemberVariable(paramName, value);
      }

      // Initiate and Execute method
      this.responseData = await actionInstance.executeMethod();
      const { responseString, responseOptions, packageName } = actionInstance.getResponseString();

      // If encryption mode is enabled then encrypt the response data
      if (encryptionState) {
        // this.responseData = new URLSearchParams({data: encrypt(this.responseData)}).toString().replace("data=",'');
        this.responseData = encrypt(this.responseData);
      }

      const response = this.getResponse(responseString, responseOptions, packageName);
      return response;

    } catch (e) {
      console.log("Exception caught", e);
      const response = this.getResponse(e === "NODE_VERSION_ERROR" ? e : "");
      if (process.env.MODE == "DEV" && e.message) this.setDebugMessage(e.message);
      return response;
    }
  }

  /** HELPER METHODS */

  // TODO: In future we will move this to an Authorization class
  validateAccesstoken = async (accessToken) => {
    let validationResponse = { error: null, data: {} };
    if (!accessToken || typeof accessToken != "string" || accessToken.trim() == "") {
      validationResponse.error = { errorCode: "INVALID_INPUT_EMPTY", parameterName: 'access_token' };
      return validationResponse;
    }

    const { AUTH_MODE, JWT_SECRET, JWT_ID_KEY, DB_ID_KEY, DB_TABLE_NAME, DB_ACCESS_KEY } = JSON.parse(process.env.AUTH);
    const decodedVal = await jwt.decodeJwtToken(accessToken, JWT_SECRET);

    if (!decodedVal || !decodedVal[JWT_ID_KEY]) {
      validationResponse.error = { errorCode: "INVALID_INPUT_EMPTY", parameterName: 'access_token' };
      return validationResponse;
    }

    if (AUTH_MODE == "JWT_SQL") {
      const verifedUser = await SQLManager.find(DB_TABLE_NAME, { [DB_ACCESS_KEY]: accessToken, [DB_ID_KEY]: decodedVal[JWT_ID_KEY] });
      if (verifedUser.length > 0) {
        validationResponse.data = verifedUser[0];
        return validationResponse;
      };
    } else {
      validationResponse.data = { [JWT_ID_KEY]: decodedVal[JWT_ID_KEY] };
      return validationResponse;
    }

    validationResponse.error = { errorCode: "INVALID_INPUT_EMPTY", parameterName: 'access_token' };
    return validationResponse;
  }

  setMemberVariable(paramName, value) {
    this[`${paramName}`] = value;
    return true;
  }

  setDebugMessage(msg) {
    this.responseMessage = msg;
  }

  setResponse(responseString, options) {
    this.responseString = responseString;
    this.responseOptions = options;
    return true;
  }

  getResponse(responseString, responseOptions, packageName) {
    if (responseString) {
      this.responseString = responseString;
      this.responseOptions = responseOptions;
    }
    const BASE_RESPONSE = require(path.resolve(process.cwd(), `src/global/i18n/response.js`)).RESPONSE;
    const PROJECT_RESPONSE = require(`../i18n/response.js`).RESPONSE;

    const CUSTOM_RESPONSE_TEMPLATE = this.getResponseTemplate();

    let RESP = { ...PROJECT_RESPONSE, ...BASE_RESPONSE };

    if (packageName) {
      try {
        let packageVals = packageName.split('/');
        const PACKAGE_RESPONSE = require(path.resolve(process.cwd(), `node_modules/${[...packageVals.slice(0, packageVals.length - 1)].join('/')}/contract/response.json`));
        RESP = { ...RESP, ...PACKAGE_RESPONSE };
      } catch {
      }
    }

    if (!RESP[this.responseString]) {
      RESP = RESP["RESPONSE_CODE_NOT_FOUND"];
    } else {
      RESP = {...RESP[this.responseString]};
    }

    RESP.responseMessage = this.lng_key && RESP.responseMessage[this.lng_key]
      ? RESP.responseMessage[this.lng_key]
      : RESP.responseMessage[DEFAULT_LNG_KEY];

     RESP.responseData = this.responseData;

    if(this.responseOptions)
    Object.keys(this.responseOptions).map(keyName => {
      RESP.responseMessage = RESP.responseMessage.replace(keyName, this.responseOptions[keyName]);
    });
 
    return this.parseResponseData(CUSTOM_RESPONSE_TEMPLATE,RESP);      

  }

  getResponseTemplate() {
    const defaultTemplate = {
      "responseCode": "<%=responseCode%>",
      "responseMessage": "<%=responseMessage%>",
      "responseData": "<%=responseData%>"
    }
    const customResponseTemplatePath = `${process.cwd()}/src/config/responseTemplate.json`;

    let template = defaultTemplate;

    if (fs.existsSync(customResponseTemplatePath)) {
      template = require(customResponseTemplatePath); 
    }

    return template;
  }

  parseResponseData(CUSTOM_RESPONSE_TEMPLATE,RESP){
    try{
      Object.entries(RESP).forEach(array => {
        const [key,value] = array;
        if(typeof value === 'object'){
          RESP[key] = "{" + JSON.stringify(value) + "}";
        }
      });
      
      const compiled = _.template(typeof CUSTOM_RESPONSE_TEMPLATE === 'string' ? CUSTOM_RESPONSE_TEMPLATE : JSON.stringify(CUSTOM_RESPONSE_TEMPLATE));

      const resultTemplate = compiled(RESP);

      const matcherObj = {
          '"{{': '{',
          '}}"': '}',
          '"{[': '[',
          ']}"': ']'
      }

      const replacedString = multiReplace(resultTemplate, matcherObj); 

      return typeof CUSTOM_RESPONSE_TEMPLATE === 'string' ? replacedString : JSON.parse(replacedString);
    }catch(error){
      throw new Error("parseResponseData Error:"+error);
    }
  }
  
}

module.exports = executor;