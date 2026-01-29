"use strict";
/**
 * Reports Module
 *
 * Cloud Functions for generating UVA (Umsatzsteuervoranmeldung) reports
 * in PDF and XML format for FinanzOnline submission.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateUvaPdfCallable = exports.generateUvaXmlCallable = void 0;
var generateUvaXml_1 = require("./generateUvaXml");
Object.defineProperty(exports, "generateUvaXmlCallable", { enumerable: true, get: function () { return generateUvaXml_1.generateUvaXmlCallable; } });
var generateUvaPdf_1 = require("./generateUvaPdf");
Object.defineProperty(exports, "generateUvaPdfCallable", { enumerable: true, get: function () { return generateUvaPdf_1.generateUvaPdfCallable; } });
//# sourceMappingURL=index.js.map