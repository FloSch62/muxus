// ssh2 does not declare its private protocol modules, but a static import is
// required here so the Electrobun build can include this dependency.
// @ts-expect-error -- no declaration exists for this ssh2 internal module.
import constants from 'ssh2/lib/protocol/constants.js';

interface Ssh2Constants {
  SUPPORTED_KEX: string[];
  SUPPORTED_CIPHER: string[];
  SUPPORTED_SERVER_HOST_KEY: string[];
  SUPPORTED_MAC: string[];
}

export default constants as Ssh2Constants;
