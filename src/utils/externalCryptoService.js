/**
 * Copyright (c) 2018, 2019 National Digital ID COMPANY LIMITED
 * 
 * This file is part of NDID software.
 * 
 * NDID is the free software: you can redistribute it and/or modify it under
 * the terms of the Affero GNU General Public License as published by the
 * Free Software Foundation, either version 3 of the License, or any later
 * version.
 * 
 * NDID is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the Affero GNU General Public License for more details.
 * 
 * You should have received a copy of the Affero GNU General Public License
 * along with the NDID source code. If not, see https://www.gnu.org/licenses/agpl.txt.
 * 
 * Please contact info@ndid.co.th for any further questions
 * 
 */

import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

import fetch from 'node-fetch';

import { hash, publicEncrypt, verifySignature } from './crypto';
import * as tendermintNdid from '../tendermint/ndid';
import CustomError from '../error/customError';
import errorType from '../error/type';
import logger from '../logger';

import * as config from '../config';

const TEST_MESSAGE = 'test';
const TEST_MESSAGE_BASE_64 = Buffer.from(TEST_MESSAGE).toString('base64');

const callbackUrls = {};

const callbackUrlFilesPrefix = path.join(
  config.dataDirectoryPath,
  'dpki-callback-url-' + config.nodeId
);

export const eventEmitter = new EventEmitter();

[
  { key: 'sign_url', fileSuffix: 'signature' },
  { key: 'master_sign_url', fileSuffix: 'masterSignature' },
  { key: 'decrypt_url', fileSuffix: 'decrypt' },
].forEach(({ key, fileSuffix }) => {
  try {
    callbackUrls[key] = fs.readFileSync(
      callbackUrlFilesPrefix + '-' + fileSuffix,
      'utf8'
    );
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.warn({
        message: `DPKI: ${fileSuffix} callback url file not found`,
      });
    } else {
      logger.error({
        message: `Cannot read DPKI: ${fileSuffix} callback url file`,
        error,
      });
    }
  }
});

async function testSignCallback(url, publicKey) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      node_id: config.nodeId,
      request_message: TEST_MESSAGE,
      request_message_hash: hash(TEST_MESSAGE),
      hash_method: 'SHA256',
      key_type: 'RSA',
      sign_method: 'RSA-SHA256',
    }),
  });
  const { signature } = await response.json();
  if (!verifySignature(signature, publicKey, TEST_MESSAGE)) {
    throw new CustomError({
      message: 'Invalid signature',
    });
  }
}

async function testDecryptCallback(url, publicKey) {
  const encryptedMessage = publicEncrypt(publicKey, TEST_MESSAGE);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      node_id: config.nodeId,
      encrypted_message: encryptedMessage,
      key_type: 'RSA',
    }),
  });
  const decryptedMessageBase64 = (await response.json()).decrypted_message;
  if (TEST_MESSAGE_BASE_64 !== decryptedMessageBase64) {
    throw new CustomError({
      message: 'Decrypted message mismatch',
    });
  }
}

export function getCallbackUrls() {
  return callbackUrls;
}

export function isCallbackUrlsSet() {
  return (
    callbackUrls.sign_url != null &&
    callbackUrls.master_sign_url != null &&
    callbackUrls.decrypt_url != null
  );
}

function checkAndEmitAllCallbacksSet() {
  if (isCallbackUrlsSet()) {
    eventEmitter.emit('allCallbacksSet');
  }
}

export async function setDpkiCallback(signCallbackUrl, decryptCallbackUrl) {
  let public_key;

  if (signCallbackUrl) {
    try {
      if (public_key == null) {
        public_key = (await tendermintNdid.getNodePubKey(config.nodeId)).public_key;
      }
      await testSignCallback(signCallbackUrl, public_key);
    } catch (error) {
      throw new CustomError({
        message: errorType.EXTERNAL_SIGN_TEST_FAILED.message,
        code: errorType.EXTERNAL_SIGN_TEST_FAILED.code,
        cause: error,
      });
    }

    callbackUrls.sign_url = signCallbackUrl;
    fs.writeFile(
      callbackUrlFilesPrefix + '-signature',
      signCallbackUrl,
      (err) => {
        if (err) {
          logger.error({
            message: 'Cannot write DPKI sign callback url file',
            error: err,
          });
        }
      }
    );
  }
  if (decryptCallbackUrl) {
    try {
      if (public_key == null) {
        public_key = (await tendermintNdid.getNodePubKey(config.nodeId)).public_key;
      }
      await testDecryptCallback(decryptCallbackUrl, public_key);
    } catch (error) {
      throw new CustomError({
        message: errorType.EXTERNAL_DECRYPT_TEST_FAILED.message,
        code: errorType.EXTERNAL_DECRYPT_TEST_FAILED.code,
        cause: error,
      });
    }

    callbackUrls.decrypt_url = decryptCallbackUrl;
    fs.writeFile(
      callbackUrlFilesPrefix + '-decrypt',
      decryptCallbackUrl,
      (err) => {
        if (err) {
          logger.error({
            message: 'Cannot write DPKI sign callback url file',
            error: err,
          });
        }
      }
    );
  }
  checkAndEmitAllCallbacksSet()
}

export async function setMasterSignatureCallback(url) {
  if (url) {
    try {
      const { master_public_key } = await tendermintNdid.getNodeMasterPubKey(config.nodeId);
      await testSignCallback(url, master_public_key);
    } catch (error) {
      throw new CustomError({
        message: errorType.EXTERNAL_SIGN_MASTER_TEST_FAILED.message,
        code: errorType.EXTERNAL_SIGN_MASTER_TEST_FAILED.code,
        cause: error,
      });
    }

    callbackUrls.master_sign_url = url;
    fs.writeFile(callbackUrlFilesPrefix + '-masterSignature', url, (err) => {
      if (err) {
        logger.error({
          message: 'Cannot write DPKI master-sign callback url file',
          error: err,
        });
      }
    });
  }
  checkAndEmitAllCallbacksSet();
}

export async function decryptAsymetricKey(encryptedMessage) {
  const url = callbackUrls.decrypt_url;
  if (url == null) {
    throw new CustomError({
      message: errorType.EXTERNAL_DECRYPT_URL_NOT_SET.message,
      code: errorType.EXTERNAL_DECRYPT_URL_NOT_SET.code,
    });
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        node_id: config.nodeId,
        encrypted_message: encryptedMessage,
        key_type: 'RSA',
      }),
    });
    const decryptedMessageBase64 = (await response.json()).decrypted_message;
    return Buffer.from(decryptedMessageBase64, 'base64');
  } catch (error) {
    // TODO: retry
    logger.error({
      message: 'Error calling external crypto service: decrypt',
      callbackUrl: url,
    });
    throw error;
  }
}

export async function createSignature(message, messageHash, useMasterKey) {
  const url = useMasterKey
    ? callbackUrls.master_sing_url
    : callbackUrls.sign_url;
  if (url == null) {
    if (useMasterKey) {
      throw new CustomError({
        message: errorType.EXTERNAL_SIGN_MASTER_URL_NOT_SET.message,
        code: errorType.EXTERNAL_SIGN_MASTER_URL_NOT_SET.code,
      });
    } else {
      throw new CustomError({
        message: errorType.EXTERNAL_SIGN_URL_NOT_SET.message,
        code: errorType.EXTERNAL_SIGN_URL_NOT_SET.code,
      });
    }
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        node_id: config.nodeId,
        request_message: message,
        request_message_hash: messageHash,
        hash_method: 'SHA256',
        key_type: 'RSA',
        sign_method: 'RSA-SHA256',
      }),
    });
    return (await response.json()).signature;
  } catch (error) {
    // TODO: retry
    logger.error({
      message: 'Error calling external crypto service: sign',
      useMasterKey,
      callbackUrl: url,
    });
    throw error;
  }
}
