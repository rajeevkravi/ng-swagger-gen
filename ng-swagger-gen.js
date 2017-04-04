'use strict';

const fs = require('fs');
const url = require('url');
const http = require('http');
const https = require('https');
const path = require('path');
const Mustache = require('mustache');

/**
 * Main generate function
 */
function ngSwaggerGen(options) {
  if (typeof options.swagger != 'string') {
    console.log("Swagger file not specified in the 'swagger' option");
    process.exit(1);
  }

  var u = url.parse(options.swagger);
  var isHttp = u.protocol === 'http:';
  var isHttps = u.protocol === 'https:';
  if (isHttp || isHttps) {
    // The swagger definition is an HTTP(S) URL - fetch it
    (isHttp ? http : https).get(options.swagger, (res) => {
      const statusCode = res.statusCode;
      const contentType = res.headers['content-type'];

      if (statusCode !== 200) {
        console.log("Server responded with status code " + statusCode + " the request to " + options.swagger);
        process.exit(1);
      }

      res.setEncoding('utf8');
      var data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        // Proceed with the generation
        doGenerate(data, options);
      });
    }).on('error', (err) => {
        console.log("Error reading swagger JSON URL " + options.swagger + ": " + err.message);
        process.exit(1);
    });
  } else {
    // The swagger definition is a local file
    if (!fs.existsSync(options.swagger)) {
      console.log("Swagger definition file doesn't exist: " + options.swagger);
      process.exit(1);
    }
    fs.readFile(options.swagger, "UTF-8", (err, data) => {
      if (err) {
        console.log("Error reading swagger JSON file " + options.swagger + ": " + err.message);
        process.exit(1);
      } else {
        // Proceed with the generation
        doGenerate(data, options);
      }
    });
  }
}

/**
 * Proceedes with the generation given the swagger descriptor content
 */
function doGenerate(swaggerContent, options) {
  if (!options.templates) {
    options.templates = path.join(__dirname, 'templates');
  }

  var templates = options.templates;
  var output = options.output || 'src/app/api';

  var swagger = JSON.parse(swaggerContent);
  if (typeof swagger != 'object') {
    console.log("Invalid swagger content");
    process.exit(1);
  }
  if (swagger.swagger !== '2.0') {
    console.log("Invalid swagger specification. Must be a 2.0. Currently " + swagger.swagger);
    process.exit(1);
  }
  swagger.paths = swagger.paths || {};
  swagger.models = swagger.models || [];
  var models = processModels(swagger);
  var services = processServices(swagger, models);

  // Apply the tag filter. If includeTags is null, uses all services, but still removes unused models
  var includeTags = options.includeTags;
  if (typeof includeTags == 'string') {
    includeTags = includeTags.split(",");
  }
  applyTagFilter(models, services, includeTags, options.ignoreUnusedModels !== false);

  // Read the templates
  var templates = {}
  var files = fs.readdirSync(options.templates);
  files.forEach(function (file, index) {
    var pos = file.indexOf(".mustache");
    if (pos >= 0) {
      var fullFile = path.join(options.templates, file);
      templates[file.substr(0, pos)] = fs.readFileSync(fullFile, 'utf-8');
    }
  });

  // Prepare the output folder
  const modelsOutput = path.join(output, '/models');
  const servicesOutput = path.join(output, '/services');
  mkdirs(modelsOutput);
  mkdirs(servicesOutput);

  var removeStaleFiles = options.removeStaleFiles === true;

  // Utility function to render a template and write it to a file
  var generate = function (template, model, file) {
    var code = Mustache.render(template, model, templates);
    fs.writeFileSync(file, code, "UTF-8");
    console.log("Wrote " + file);
  };

  // Write the models
  var modelsArray = [];
  for (var modelName in models) {
    var model = models[modelName];
    modelsArray.push(model);
    generate(templates.model, model, modelsOutput + "/" + model.modelFile + ".ts");
  }
  if (modelsArray.length > 0) {
    modelsArray[modelsArray.length - 1].last = true;
  }
  if (removeStaleFiles) {
    var modelFiles = fs.readdirSync(modelsOutput);
    modelFiles.forEach((file, index) => {
      var ok = false;
      var basename = path.basename(file);
      for (var modelName in models) {
        var model = models[modelName];
        if (basename == model.modelFile + '.ts') {
          ok = true;
          break;
        }
      }
      if (!ok) {
        rmIfExists(path.join(modelsOutput, file));
      }
    });
  }

  // Write the model index
  var modelIndexFile = output + "/models.ts";
  if (options.modelIndex !== false) {
    generate(templates.models, { "models": modelsArray }, modelIndexFile);
  } else if (removeStaleFiles) {
    rmIfExists(modelIndexFile);
  }

  // Write the services
  var servicesArray = [];
  for (var serviceName in services) {
    var service = services[serviceName];
    servicesArray.push(service);
    generate(templates.service, service, servicesOutput + "/" + service.serviceFile + ".ts");
  }
  if (servicesArray.length > 0) {
    servicesArray[servicesArray.length - 1].last = true;
  }
  if (removeStaleFiles) {
    var serviceFiles = fs.readdirSync(servicesOutput);
    serviceFiles.forEach((file, index) => {
      var ok = false;
      var basename = path.basename(file);
      for (var serviceName in services) {
        var service = services[serviceName];
        if (basename == service.serviceFile + '.ts') {
          ok = true;
          break;
        }
      }
      if (!ok) {
        rmIfExists(path.join(servicesOutput, file));
      }
    });
  }

  // Write the service index
  var serviceIndexFile = output + "/services.ts";
  if (options.serviceIndex !== false) {
    generate(templates.services, { "services": servicesArray }, serviceIndexFile);
  } else if (removeStaleFiles) {
    rmIfExists(serviceIndexFile);
  }

  // Write the api module
  var apiModuleFile = output + "/api.module.ts";
  if (options.apiModule !== false) {
    generate(templates.apiModule, { "services": servicesArray }, apiModuleFile);
  } else if (removeStaleFiles) {
    rmIfExists(apiModuleFile);
  }

  // Write the ApiConfiguration
  {
    var schemes = swagger.schemes || [];
    var scheme = schemes.length == 0 ? 'http' : schemes[0];
    var host = (swagger.host || "localhost");
    var basePath = (swagger.basePath || "/");
    var rootUrl = scheme + "://" + host + basePath;
    generate(templates.apiConfiguration, { "rootUrl": rootUrl }, output + "/api-configuration.ts");
  }
}

/**
 * Applies a filter over the given services, keeping only the specific tags.
 * Also optionally removes any unused models, even if includeTags is null (meaning all).
 */
function applyTagFilter(models, services, includeTags, ignoreUnusedModels) {
  var usedModels = new Set();
  for (var serviceName in services) {
    var include = !includeTags || includeTags.indexOf(serviceName) >= 0;
    if (!include) {
      // This service is skipped - remove it
      console.log("Ignoring service " + serviceName + " because it was not included");
      delete services[serviceName];
    } else if (ignoreUnusedModels) {
      // Collect the models used by this service
      var service = services[serviceName];
      service.serviceDependencies.forEach((dep, index) => usedModels.add(dep));
    }
  }

  if (ignoreUnusedModels) {
    // Collect the model dependencies of models, so unused can be removed
    var allDependencies = new Set();
    usedModels.forEach(dep => collectDependencies(allDependencies, dep, models));

    // Remove all models that are unused
    for (var modelName in models) {
      if (!allDependencies.has(modelName)) {
        // This model is not used - remove it
        console.log("Ignoring model " + modelName + " because it was not used by any service");
        delete models[modelName];
      }
    }
  }
}

/**
 * Collects on the given dependencies set all dependencies of the given model name
 */
function collectDependencies(dependencies, model, models) {
  if (!model || dependencies.has(model.modelName)) {
    return;
  }
  dependencies.add(model.modelName);
  if (model.modelDependencies) {
    model.modelDependencies.forEach((dep, index) =>
      collectDependencies(dependencies, dep, models));
  }
}

/**
 * Creates all sub-directories for a nested path
 * Thanks to https://github.com/grj1046/node-mkdirs/blob/master/index.js
 */
function mkdirs(folderPath, mode) {
    var folders = [];
    var tmpPath = path.normalize(folderPath);
    var exists = fs.existsSync(tmpPath);
    while (!exists) {
        folders.push(tmpPath);
        tmpPath = path.join(tmpPath, '..');
        exists = fs.existsSync(tmpPath);
    }

    for (var i = folders.length - 1; i >= 0; i--) {
        fs.mkdirSync(folders[i], mode);
    }
}

/**
 * Removes the given file if it exists (logging the action)
 */
function rmIfExists(file) {
  if (fs.existsSync(file)) {
    console.log("Removing stale file " + file);
    fs.unlinkSync(file);
  }
}

/**
 * Converts a given type name into a TS file name
 */
function toFileName(typeName) {
  var result = "";
  var wasLower = false;
  for (var i = 0; i < typeName.length; i++) {
    var c = typeName.charAt(i);
    var isLower = /[a-z]/.test(c);
    if (!isLower && wasLower) {
      result += "-";
    }
    result += c.toLowerCase();
    wasLower = isLower;
  }
  return result;
}

/**
 * Resolves the simple reference name from a qualified reference
 */
function simpleRef(ref) {
  if (!ref) {
    return null;
  }
  var index = ref.lastIndexOf('/');
  if (index >= 0) {
    return ref.substr(index + 1);
  } else {
    return ref;
  }
}

/**
* Converts a given enum value into the enum name
*/
function toEnumName(value) {
  var result = "";
  var wasLower = false;
  for (var i = 0; i < value.length; i++) {
    var c = value.charAt(i);
    var isLower = /[a-z]/.test(c);
    if (!isLower && wasLower) {
      result += "_";
    }
    result += c.toUpperCase();
    wasLower = isLower;
  }
  return result;
}

/**
 * Returns a multi-line comment for the given text
 */
function toComments(text, level) {
  var indent = "";
  for (var i = 0; i < level; i++) {
    indent += "  ";
  }
  var result = indent + "/**\n";
  var lines = (text || "").split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.length > 0) {
      result += indent + " * " + line + "\n";
    }
  }
  result += indent + " */";
  return result;
}

/**
 * Class used to resolve the model dependencies
 */
function DependenciesResolver(models, ownType) {
  this.models = models;
  this.ownType = ownType;
  this.dependencies = [];
  this.dependencyNames = [];
}
/**
 * Adds a candidate dependency
 */
DependenciesResolver.prototype.add = function (dep) {
  dep = removeBrackets(dep);
  if (this.dependencyNames.indexOf(dep) < 0 && dep !== this.ownType) {
    var depModel = this.models[dep];
    if (depModel) {
      this.dependencies.push(depModel);
      this.dependencyNames.push(dep);
    }
  }
}
/**
 * Returns the resolved dependencies as a list of models
 */
DependenciesResolver.prototype.get = function () {
  return this.dependencies;
}

/**
 * Process each model, returning an object keyed by model name, whose values
 * are simplified descriptors for models.
 */
function processModels(swagger) {
  var models = {};
  for (var name in swagger.definitions) {
    var model = swagger.definitions[name];
    var parent = null;
    var properties = null;
    var requiredProperties = null;
    var enumValues = null;
    if (model.allOf != null && model.allOf.length > 0) {
      parent = simpleRef((model.allOf[0] || {}).$ref);
      properties = (model.allOf[1] || {}).properties || {};
      requiredProperties = (model.allOf[1] || {}).required || [];
    } else if (model.type === 'object') {
      properties = model.properties || {};
      requiredProperties = model.required || [];
    } else if (model.type === 'string') {
      enumValues = model.enum || [];
      if (enumValues.length == 0) {
        console.log("Enum " + name + " has no possible values");
        process.exit(1);
      } else {
        for (var i = 0; i < enumValues.length; i++) {
          var enumValue = enumValues[i];
          var enumDescriptor = {
            "enumName": toEnumName(enumValue),
            "enumValue": enumValue,
            "last": i === enumValues.length - 1
          }
          enumValues[i] = enumDescriptor;
        }
      }
    } else {
      console.log("Unhandled model type for " + name);
      process.exit(1);
    }
    var descriptor = {
      "modelName": name,
      "modelClass": name,
      "modelFile": toFileName(name),
      "modelComments": toComments(model.description),
      "modelParent": parent,
      "modelIsObject": properties != null,
      "modelIsEnum": enumValues != null,
      "properties": properties == null ? null :
        processProperties(swagger, properties, requiredProperties),
      "modelEnumValues": enumValues,
      "modelSubclasses": []
    };

    if (descriptor.properties != null) {
      descriptor.modelProperties = [];
      for (var propertyName in descriptor.properties) {
        var property = descriptor.properties[propertyName];
        descriptor.modelProperties.push(property);
      }
      descriptor.modelProperties.sort((a, b) => {
        return a.modelName < b.modelName
          ? -1 : a.modelName > b.modelName ? 1 : 0;
      });
      if (descriptor.modelProperties.length > 0) {
        descriptor.modelProperties[descriptor.modelProperties.length - 1]
          .last = true;
      }
    }

    models[name] = descriptor;
  }

  // Now that we know all models, process the hierarchies
  for (var name in models) {
    var model = models[name];
    if (!model.modelIsObject) {
      // Only objects can have hierarchies
      continue;
    }

    // Process the hierarchy
    var parentName = model.modelParent;
    if (parentName) {
      // Make the parent be the actual model, not the name
      model.modelParent = models[parentName];

      // Append this model on the parent's subclasses
      model.modelParent.modelSubclasses.push(model);
    }
  }

  // Now that the model hierarchy is ok, resolve the dependencies
  for (var name in models) {
    var model = models[name];
    if (!model.modelIsObject) {
      // Only objects can have dependencies
      continue;
    }
    var dependencies = new DependenciesResolver(models, model.modelName);

    // The parent is a dependency
    if (model.modelParent) {
      dependencies.add(model.modelParent.modelName);
    }

    // The subclasses are dependencies
    for (var i = 0; i < model.modelSubclasses.length; i++) {
      var child = model.modelSubclasses[i];
      dependencies.add(child.modelName);
    }

    // Each property may add a dependency
    for (var i = 0; i < model.modelProperties.length; i++) {
      var property = model.modelProperties[i];
      var type = property.propertyType;
      if (type.allTypes) {
        // This is an inline object. Append all types
        type.allTypes.forEach((t, i) => dependencies.add(t));
      } else {
        dependencies.add(type);
      }
    }
    model.modelDependencies = dependencies.get();

  }

  return models;
}

/**
 * Removes an array designation from the given type.
 * For example, "a[]" returns "a", while "b" returns "b".
 */
function removeBrackets(type) {
  var pos = (type || "").indexOf("[");
  return pos >= 0 ? type.substr(0, pos) : type;
}

/**
 * Returns the TypeScript property type for the given raw property
 */
function propertyType(property) {
  if (property == null) {
    return "void";
  } else if (property.$ref != null) {
    // Type is a reference
    return simpleRef(property.$ref);
  } else if (property["x-type"]) {
    // Type is read from the x-type vendor extension
    var type = (property["x-type"] || "").toString().replace("List<", "Array<");
    var pos = type.indexOf("Array<");
    if (pos >= 0) {
      type = type.substr("Array<".length, type.length - 1) + "[]";
    }
    return type.length == 0 ? 'void' : type;
  }
  switch (property.type) {
    case "string":
      return "string";
    case "array":
      return propertyType(property.items) + "[]";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "Boolean";
    case "object":
      var def = "{";
      var first = true;
      var allTypes = [];
      if (property.properties) {
        for (var name in property.properties) {
          var prop = property.properties[name];
          if (first) {
            first = false;
          } else {
            def += ", ";
          }
          var type = propertyType(prop);
          if (allTypes.indexOf(type) < 0) {
            allTypes.push(type);
          }
          def += name + ": " + type;
        }
      }
      if (property.additionalProperties) {
        if (!first) {
          def += ", ";
        }
        var type = propertyType(property.additionalProperties);
        if (allTypes.indexOf(type) < 0) {
          allTypes.push(type);
        }
        def += "[key: string]: " + type;
      }
      def += "}";
      return {
        allTypes: allTypes,
        toString: () => def
      };
    default:
      return "any";
  }
}

/**
 * Process each property for the given properties object, returning an object
 * keyed by property name with simplified property types
 */
function processProperties(swagger, properties, requiredProperties) {
  var result = {};
  for (var name in properties) {
    var property = properties[name];
    var descriptor = {
      "propertyName": name,
      "propertyComments": toComments(property.description),
      "propertyRequired": requiredProperties.indexOf(name) >= 0,
      "propertyType": propertyType(property)
    }
    result[name] = descriptor;
  }
  return result;
}

/**
 * Resolves a local reference in the given swagger file
 */
function resolveRef(swagger, ref) {
  if (ref.indexOf("#/") != 0) {
    console.log("Resolved references must start with #/. Current: " + ref);
    process.exit(1);
  }
  var parts = ref.substr(2).split("/");
  var result = swagger;
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    result = result[part];
  }
  return result === swagger ? {} : result;
}

/*
 * Process an operation's possible responses. Returns an object keyed
 * by each HTTP code, whose values are objects with code and type properties,
 * plus a property resultType, which is the type to the HTTP 2xx code.
 */
function processResponses(def, path, models) {
  var responses = def.responses || {};
  var operationResponses = {};
  for (var code in responses) {
    var response = responses[code];
    if (!response.schema) {
      continue;
    }
    var type = propertyType(response.schema);
    if (/2\d\d/.test(code)) {
      // Successful response
      operationResponses.resultType = type;
    }
    operationResponses[code] = {
      "code": code,
      "type": type
    };
  }
  if (!operationResponses.resultType) {
    operationResponses.resultType = 'void';
  }
  return operationResponses;
}

/**
 * Returns a path expression to be evaluated, for example:
 * "/a/{var1}/b/{var2}/" returns "/a/${params.var1}/b/${params.var2}"
 */
function toPathExpression(path) {
  return (path || "").replace("{", "${params.");
}

/**
 * Process API paths, returning an object with descriptors keyed by tag name.
 * It is required that operations define a single tag, or they are ignored.
 */
function processServices(swagger, models) {
  var services = {};
  for (var url in swagger.paths) {
    var path = swagger.paths[url];
    for (var method in (path || {})) {
      var def = path[method];
      if (!def) {
        continue;
      }
      var tags = def.tags || [];
      if (tags.length == 0) {
        console.log("Ignoring " + name + "." + method
          + " because it has no tags");
        continue;
      } else if (tags.length > 1) {
        console.log("Ignoring " + name + "." + method
          + " because it has multiple tags: " + tags);
        continue;
      }
      var tag = tags[0];
      var descriptor = services[tag];
      if (descriptor == null) {
        descriptor = {
          "serviceName": tag,
          "serviceClass": tag + "Service",
          "serviceFile": toFileName(tag) + ".service",
          "serviceOperations": []
        };
        services[tag] = descriptor;
      }

      var id = def.operationId;
      if (id == null) {
        console.log("Ignoring " + name + "." + method
          + " because it has no id");
        continue;
      }
      var operationParameters = [];
      for (var p = 0; p < def.parameters.length; p++) {
        var param = def.parameters[p];
        if (param.$ref) {
          param = resolveRef(swagger, param.$ref);
        }
        var paramType;
        if (param.schema) {
          paramType = propertyType(param.schema);
        } else {
          paramType = propertyType(param);
        }
        var paramDescriptor = {
          "paramName": param.name,
          "paramIn": param.in,
          "paramRequired": param.required === true || param.in === 'path',
          "paramIsQuery": param.in === 'query',
          "paramIsPath": param.in === 'path',
          "paramIsHeader": param.in === 'header',
          "paramIsBody": param.in === 'body',
          "paramIsArray": param.type === 'array',
          "paramDescription": param.description,
          "paramComments": toComments(param.description, 1),
          "paramType": paramType,
          "paramCollectionFormat": param.collectionFormat
        };
        operationParameters.push(paramDescriptor);
      }
      operationParameters.sort((a, b) => {
        if (a.paramRequired && !b.paramRequired) return -1;
        if (!a.paramRequired && b.paramRequired) return 1;
        return a.paramName > b.paramName
          ? -1 : a.paramName < b.paramName ? 1 : 0;
      });
      if (operationParameters.length > 0) {
        operationParameters[operationParameters.length - 1].last = true;
      }
      var paramsClass = operationParameters.length == 0
        ? null : id.charAt(0).toUpperCase() + id.substr(1) + "Params";
      var operationResponses = processResponses(def, path, models);
      var resultType = operationResponses.resultType;
      var docString = def.description || "";
      for (var i = 0; i < operationParameters.length; i++) {
        var param = operationParameters[i];
        docString += "\n@param " + param.paramName + " - " + param.paramDescription;
      }
      var operation = {
        "operationName": id,
        "operationParamsClass": paramsClass,
        "operationMethod": method.toLocaleLowerCase(),
        "operationPath": url,
        "operationPathExpression": toPathExpression(url),
        "operationComments": toComments(docString, 1),
        "operationResultType": resultType,
        "operationParameters": operationParameters,
        "operationResponses": operationResponses
      }
      operation.operationIsVoid = resultType === 'void';
      operation.operationIsString = resultType === 'string';
      operation.operationIsNumber = resultType === 'number';
      operation.operationIsBoolean = resultType === 'boolean';
      var modelResult = models[removeBrackets(resultType)];
      operation.operationIsEnum = modelResult && modelResult.modelIsEnum;
      operation.operationIsObject = modelResult && modelResult.modelIsObject;
      operation.operationIsUnknown = !(operation.operationIsVoid
        || operation.operationIsString || operation.operationIsNumber
        || operation.operationIsBoolean || operation.operationIsEnum
        || operation.operationIsObject);
      descriptor.serviceOperations.push(operation);
    }
    services[tag] = descriptor;

    // Resolve the models used by the service
    var dependencies = new DependenciesResolver(models);
    for (var i = 0; i < descriptor.serviceOperations.length; i++) {
      var op = descriptor.serviceOperations[i];
      for (var code in op.operationResponses) {
        var response = op.operationResponses[code]
        dependencies.add(response.type);
      }
      for (var j = 0; j < op.operationParameters.length; j++) {
        var param = op.operationParameters[j];
        dependencies.add(param.paramType);
      }
    }
    descriptor.serviceDependencies = dependencies.get();
  }
  return services;
}

module.exports = ngSwaggerGen;
