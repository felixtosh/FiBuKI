/**
 * Reports Module
 *
 * Cloud Functions for generating UVA (Umsatzsteuervoranmeldung) reports
 * in PDF and XML format for FinanzOnline submission.
 */

export { generateUvaXmlCallable } from "./generateUvaXml";
export { generateUvaPdfCallable } from "./generateUvaPdf";
