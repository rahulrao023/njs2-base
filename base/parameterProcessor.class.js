
const { decrypt } = require("./encryption");
const { ENCRYPTION_MODE } = JSON.parse(process.env.ENCRYPTION);
const ENC_MODE = require('../lib/constants')

class ParameterProcessor extends baseAction {

  async processParameter(initializer, request, encState) {
    let requestData;
    let encryptionState = true;
    const params = initializer.getParameter();

    this.removeUndefinedParameters(params, {}, requestData);

    this.trimRequestParameterValues(requestData);

    return requestData;
  }

  //checks if all the parameters given in request has been specified in init script. if not removes them from requestData object
  removeUndefinedParameters(paramData, authParamData, requestData) {

    let matchFound = false;
    for (let requestParamName in requestData) {
      matchFound = false;
      for (let paramName in paramData) {
        if (requestParamName == paramData[`${paramName}`].name) {
          matchFound = true;
        }
      }
      for (let paramName in authParamData) {
        if (requestParamName == authParamData[`${paramName}`].name) {
          matchFound = true;
        }
      }
      if (!matchFound) {
        delete requestData[`${requestParamName}`];
      }
    }
  }


  //trims the spaces if any in the request parameter's value
  trimRequestParameterValues(requestData) {
    for (let paramName in requestData) {
      if (typeof (requestData[`${paramName}`]) == "string") {
        requestData[`${paramName}`] = requestData[`${paramName}`].trim();
      }
    }
  }

  validateParameters(param, requestData) {
    let responseObj = { error: null, data: {} };
    let isSuccessfull = this.verifyRequiredParameter(param, requestData);
    if (!isSuccessfull) {
      responseObj.error = { errorCode: "INVALID_INPUT_EMPTY", parameterName: param.name };
      return responseObj;
    }

    if (!this.convertToGivenParameterType(param, requestData)) {
      responseObj.error = { errorCode: "INVALID_INPUT_EMPTY", parameterName: param.name };
      return responseObj;
    }
    this.setDefaultParameters(param, requestData);
    responseObj.data = requestData;
    return responseObj;
  }

  //converts all the request parameters to the specified type(number and string)
  convertToGivenParameterType(paramData, requestData) {
    if (requestData && requestData != "") {
      if (paramData.type == "number") {
        requestData = Number(requestData);
        if (isNaN(requestData)) {
          //set error response if a parameter is specified in request but is not an integer
          return false;
        }
      } else if (paramData.type == "string") {
        requestData = requestData.toString();
      }
    } else if (requestData == "") {
      //set error response if a parameter is specified in request but is empty
      return false;
    }
    return true;
  }

  //if the given parameter has a default value specified and request does not have that parameter
  //then set that default value for that parameter in the request
  setDefaultParameters(paramData, requestData) {
    if (!requestData) {
      if (paramData.type == "number" && paramData.default !== "") {
        requestData = Number(paramData.default);
      } else if (paramData.type == "string" && paramData.default !== "") {
        requestData = paramData.default.toString();
      }
    }
  }

  //checks if the parameter is set as required and the that parameter has some value in the request
  verifyRequiredParameter(paramData, requestData) {
    //checks if the paramater is given in request by user
    if (paramData.required && ((typeof (requestData) == "string" && requestData.trim() == "") || (typeof (requestData) == "number" && isNaN(requestData)))) {
      return false;
    }

    return true;
  }
}

module.exports = ParameterProcessor;