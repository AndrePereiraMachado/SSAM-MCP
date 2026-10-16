// CX15 r3 test preload (BYPASS-1), loaded with `node --import` into a child `.\odc studio` process: the CLI believes the
// bridge DLL of the source's protocol version (studio\bridge\client\Program.cs) is built, so its real pipe client
// (odc-pipe.mjs) connects to ODC3-Bridge-<version>-<pid>, which the test serves as a fake bridge that only counts lines.
// Nothing else changes: no Studio, no network, no file written.
import fs from 'node:fs';
const existsSync = fs.existsSync;
const BRIDGE_BIN = /[\\/]studio[\\/]bridge[\\/]bin[\\/]Release[\\/]net8\.0([\\/]ODC3\.Bridge\.v\d+\.dll)?$/i;
fs.existsSync = file => (BRIDGE_BIN.test(String(file)) ? true : existsSync(file));
