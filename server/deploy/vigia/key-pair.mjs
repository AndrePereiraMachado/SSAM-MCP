// Private stdout pipe consumed by set-secrets.ps1. Never run through a logger.
import {generateKeyPairSync} from 'node:crypto';
const pair=generateKeyPairSync('ed25519');
process.stdout.write(JSON.stringify({privateKey:pair.privateKey.export({type:'pkcs8',format:'pem'}),publicKey:pair.publicKey.export({type:'spki',format:'pem'})}));
