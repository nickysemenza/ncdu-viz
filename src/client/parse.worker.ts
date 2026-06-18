import * as Comlink from "comlink";
import { decodeScan } from "../shared/decode";

// Thin worker boundary: decompression + parsing runs here, off the main thread.
export const parseApi = { parse: decodeScan };
export type ParseApi = typeof parseApi;

Comlink.expose(parseApi);
