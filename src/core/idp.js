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
import fetch from 'node-fetch';

import { callbackToClient } from '../utils/callback';
import CustomError from '../error/customError';
import errorType from '../error/type';
import logger from '../logger';

import * as tendermint from '../tendermint';
import * as tendermintNdid from '../tendermint/ndid';
import * as common from './common';
import * as utils from '../utils';
import * as config from '../config';
import * as db from '../db';
import * as mq from '../mq';
import * as identity from './identity';

const callbackUrls = {};

const callbackUrlFilesPrefix = path.join(
  config.dataDirectoryPath,
  'idp-callback-url-' + config.nodeId,
);

[
  { key: 'incoming_request_url', fileSuffix: 'incoming_request' },
  { key: 'identity_result_url', fileSuffix: 'identity_result' },
  { key: 'accessor_sign_url', fileSuffix: 'accessor_sign' },
  { key: 'error_url', fileSuffix: 'error' },
].forEach(({ key, fileSuffix }) => {
  try {
    callbackUrls[key] = fs.readFileSync(
      callbackUrlFilesPrefix + '-' + fileSuffix,
      'utf8'
    );
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.warn({
        message: `${fileSuffix} callback url file not found`,
      });
    } else {
      logger.error({
        message: `Cannot read ${fileSuffix} callback url file`,
        error,
      });
    }
  }
});

function writeCallbackUrlToFile(fileSuffix, url) {
  fs.writeFile(callbackUrlFilesPrefix + '-' + fileSuffix, url, (err) => {
    if (err) {
      logger.error({
        message: `Cannot write ${fileSuffix} callback url file`,
        error: err,
      });
    }
  });
}

export function setCallbackUrls({
  incoming_request_url,
  identity_result_url,
  accessor_sign_url,
  error_url,
}) {
  if (incoming_request_url != null) {
    callbackUrls.incoming_request_url = incoming_request_url;
    writeCallbackUrlToFile('incoming_request', incoming_request_url);
  }
  if (identity_result_url != null) {
    callbackUrls.identity_result_url = identity_result_url;
    writeCallbackUrlToFile('identity_result', identity_result_url);
  }
  if (accessor_sign_url != null) {
    callbackUrls.accessor_sign_url = accessor_sign_url;
    writeCallbackUrlToFile('accessor_sign', accessor_sign_url);
  }
  if (error_url != null) {
    callbackUrls.error_url = error_url;
    writeCallbackUrlToFile('error', error_url);
  }
}

export function getCallbackUrls() {
  return callbackUrls;
}

export function isAccessorSignUrlSet() {
  return callbackUrls.accessor_sign_url != null;
}

export async function accessorSign(sid ,hash_id, accessor_id, reference_id) {
  const data = {
    sid_hash: hash_id,
    sid,
    hash_method: 'SHA256',
    key_type: 'RSA',
    sign_method: 'RSA',
    accessor_id,
    reference_id,
  };

  if (callbackUrls.accessor_sign_url == null) {
    throw new CustomError({
      message: errorType.SIGN_WITH_ACCESSOR_KEY_URL_NOT_SET.message,
      code: errorType.SIGN_WITH_ACCESSOR_KEY_URL_NOT_SET.code,
    });
  }

  logger.debug({
    message: 'Callback to accessor sign',
    url: callbackUrls.accessor_sign_url,
    accessor_id,
    hash_id,
  });

  try {
    const response = await fetch(callbackUrls.accessor_sign_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(data),
    });
    const signatureObj = await response.json();
    return signatureObj.signature;
  } catch (error) {
    throw new CustomError({
      message: errorType.SIGN_WITH_ACCESSOR_KEY_FAILED.message,
      code: errorType.SIGN_WITH_ACCESSOR_KEY_FAILED.code,
      cause: error,
      details: {
        callbackUrl: callbackUrls.accessor_sign_url,
        accessor_id,
        hash_id,
      }
    });
  }
}

async function requestChallenge(request_id, accessor_id) {
  //query public key from accessor_id
  let public_key = await tendermintNdid.getAccessorKey(accessor_id);
  //gen public proof
  let [ k1, publicProof1 ] = utils.generatePublicProof(public_key);
  let [ k2, publicProof2 ] = utils.generatePublicProof(public_key);

  //save k to request
  let request = await db.getRequestReceivedFromMQ(request_id);
  request.k = [ k1, k2 ];
  logger.debug({
    message: 'Save K to request',
    request,
  });
  await db.setRequestReceivedFromMQ(request_id, request);
  //declare public proof to blockchain
  let { height } = await tendermintNdid.declareIdentityProof({
    request_id,
    identity_proof: JSON.stringify([ publicProof1, publicProof2 ]),
  });
  //send message queue with public proof
  let { ip, port } = await tendermintNdid.getMsqAddress(request.rp_id);
  let receiver = [{
    ip,
    port,
    ...(await tendermintNdid.getNodePubKey(request.rp_id)),
  }];
  mq.send(receiver,{
    public_proof: [ publicProof1, publicProof2 ],
    request_id: request_id,
    idp_id: config.nodeId,
    type: 'request_challenge',
    height,
  });
}

export async function requestChallengeAndCreateResponse(data) {
  //store response data
  const request = await tendermintNdid.getRequest({ requestId: data.request_id });
  if(request.mode === 3) {
    await db.setResponseFromRequestId(data.request_id, data);
    requestChallenge(data.request_id, data.accessor_id);
  }
  else if(request.mode === 1) createIdpResponse(data);
}

async function createIdpResponse(data) {
  try {
    let {
      request_id,
      aal,
      ial,
      status,
      signature,
      accessor_id,
      secret,
    } = data;

    const request = await tendermintNdid.getRequest({ requestId: request_id });
    if (request == null) {
      throw new CustomError({
        message: errorType.REQUEST_NOT_FOUND.message,
        code: errorType.REQUEST_NOT_FOUND.code,
        clientError: true,
        details: {
          request_id,
        },
      });
    }

    const mode = request.mode;
    if (mode === 3) {
      if (accessor_id == null) {
        throw new CustomError({
          message: errorType.ACCESSOR_ID_NEEDED.message,
          code: errorType.ACCESSOR_ID_NEEDED.code,
          clientError: true,
        });
      }
      if (secret == null) {
        throw new CustomError({
          message: errorType.SECRET_NEEDED.message,
          code: errorType.SECRET_NEEDED.code,
          clientError: true,
        });
      }

      const accessorPublicKey = await tendermintNdid.getAccessorKey(accessor_id);
      if (accessorPublicKey == null) {
        throw new CustomError({
          message: errorType.ACCESSOR_PUBLIC_KEY_NOT_FOUND.message,
          code: errorType.ACCESSOR_PUBLIC_KEY_NOT_FOUND.code,
          clientError: true,
          details: {
            accessor_id,
          },
        });
      }
    }

    let dataToBlockchain, privateProofObject;

    if (mode === 3) {
      let blockchainProofArray = [], privateProofValueArray = [], samePadding;
      let requestFromMq = await db.getRequestReceivedFromMQ(request_id);

      logger.debug({
        message: 'To generate proof',
        requestFromMq,
      });

      for(let i = 0 ; i < requestFromMq.challenge.length ; i++) {
        let { blockchainProof, privateProofValue, padding } = utils.generateIdentityProof({
          publicKey: await tendermintNdid.getAccessorKey(accessor_id),
          challenge: requestFromMq.challenge[i],
          k: requestFromMq.k[i],
          secret,
        });
        blockchainProofArray.push(blockchainProof);
        privateProofValueArray.push(privateProofValue);
        samePadding = padding;
      }
    
      privateProofObject = {
        privateProofValueArray,
        accessor_id,
        padding: samePadding,
      };

      dataToBlockchain = {
        request_id,
        aal,
        ial,
        status,
        signature,
        //accessor_id,
        identity_proof: JSON.stringify(blockchainProofArray),
        private_proof_hash: utils.hash(JSON.stringify(privateProofValueArray)),
      };
    } else if (mode === 1) {
      dataToBlockchain = {
        request_id,
        aal,
        ial,
        status,
        signature,
      };
    }

    await Promise.all([
      db.removeRequestReceivedFromMQ(request_id),
      db.removeResponseFromRequestId(request_id)
    ]);
    
    const { height } = await tendermintNdid.createIdpResponse(dataToBlockchain);

    sendPrivateProofToRP(request_id, privateProofObject, height);
  } catch (error) {
    const err = new CustomError({
      message: 'Cannot create IdP response',
      cause: error,
    });
    logger.error(err.getInfoForLog());
    throw err;
  }
}

function notifyByCallback({ url, type, eventDataForCallback }) {
  if (!url) {
    logger.error({
      message: `Callback URL for type: ${type} has not been set`,
    });
    return;
  }
  return callbackToClient(
    url,
    {
      type,
      ...eventDataForCallback,
    },
    true
  );
}

export function notifyIncomingRequestByCallback(eventDataForCallback) {
  const url = callbackUrls.incoming_request_url;
  const type = 'incoming_request';
  if (!url) {
    logger.error({
      message: `Callback URL for type: ${type} has not been set`,
    });
    return;
  }
  return callbackToClient(
    url,
    {
      type,
      ...eventDataForCallback,
    },
    true,
    common.shouldRetryCallback,
    [eventDataForCallback.request_id]
  );
}

export function notifyCreateIdentityResultByCallback(eventDataForCallback) {
  notifyByCallback({
    url: callbackUrls.identity_result_url,
    type: 'create_identity_result',
    eventDataForCallback,
  });
}

export function notifyAddAccessorResultByCallback(eventDataForCallback) {
  notifyByCallback({
    url: callbackUrls.identity_result_url,
    type: 'add_accessor_result',
    eventDataForCallback,
  });
}

async function sendPrivateProofToRP(request_id, privateProofObject, height) {
  //mode 1
  if(!privateProofObject) privateProofObject = {};
  let rp_id = await db.getRPIdFromRequestId(request_id);

  logger.info({
    message: 'Query MQ destination for RP',
  });
  logger.debug({
    message: 'Query MQ destination for RP',
    rp_id,
  });

  let { ip, port } = await tendermintNdid.getMsqAddress(rp_id);
  let rpMq = {
    ip,
    port,
    ...(await tendermintNdid.getNodePubKey(rp_id)),
  };

  mq.send([rpMq], {
    request_id,
    ...privateProofObject,
    height,
    idp_id: config.nodeId,
  });

  db.removeRPIdFromRequestId(request_id);
}

export async function handleMessageFromQueue(messageStr) {
  logger.info({
    message: 'Received message from MQ',
  });
  logger.debug({
    message: 'Message from MQ',
    messageStr,
  });
  const message = JSON.parse(messageStr);
  //if message is challenge for response, no need to wait for blockchain
  if(message.challenge) {
    //store challenge
    let request = await db.getRequestReceivedFromMQ(message.request_id);
    request.challenge = message.challenge;
    logger.debug({
      message: 'Save challenge to request',
      request,
      challenge: message.challenge,
    });
    await db.setRequestReceivedFromMQ(message.request_id, request);
    //query reponse data
    let data = await db.getResponseFromRequestId(message.request_id);
    logger.debug({
      message: 'Data to response',
      data,
    });
    createIdpResponse(data);
    return;
  }

  //when idp add new accessor, they may request challenge from themself
  //this is to prevent overwrite data (k, public)
  if(message.type !== 'request_challenge') {
    await db.setRequestReceivedFromMQ(message.request_id, message);
  }
  await db.setRequestToProcessReceivedFromMQ(message.request_id, message);

  const latestBlockHeight = tendermint.latestBlockHeight;
  if (latestBlockHeight <= message.height) {
    logger.debug({
      message: 'Saving message from MQ',
      tendermintLatestBlockHeight: latestBlockHeight,
      messageBlockHeight: message.height,
    });
    await db.addRequestIdExpectedInBlock(
      message.height,
      message.request_id
    );
    await db.setRPIdFromRequestId(message.request_id, message.rp_id);

    if(message.type === 'request_challenge') {
      const responseId = message.request_id + ':' + message.idp_id;
      await db.setPublicProofReceivedFromMQ(responseId, message.public_proof);
    }

    if(message.accessor_id) {
      //====================== COPY-PASTE from RP, need refactoring =====================
      //store private parameter from EACH idp to request, to pass along to as
      let request = await db.getRequestData(message.request_id);
      //AS involve
      if (request) {
        if (request.privateProofObjectList) {
          request.privateProofObjectList.push({
            idp_id: message.idp_id,
            privateProofObject: {
              privateProofValue: message.privateProofValue,
              accessor_id: message.accessor_id,
              padding: message.padding,
            },
          });
        } else {
          request.privateProofObjectList = [
            {
              idp_id: message.idp_id,
              privateProofObject: {
                privateProofValue: message.privateProofValue,
                accessor_id: message.accessor_id,
                padding: message.padding,
              },
            },
          ];
        }
        await db.setRequestData(message.request_id, request);
      }
      //====================================================================================
    }
    return;
  }
  await db.removeRequestToProcessReceivedFromMQ(message.request_id, message);

  logger.debug({
    message: 'Processing request',
    requestId: message.request_id,
  });
  //onboard response
  if(message.accessor_id) {
    if(await checkOnboardResponse(message)) {
      let { secret, associated } = await identity.addAccessorAfterConsent(message.request_id, message.accessor_id);
      let notifyData = {
        request_id: message.request_id,
        success: true,
        secret,
      };
      if(associated) notifyAddAccessorResultByCallback(notifyData);
      else notifyCreateIdentityResultByCallback(notifyData);
    }
  }
  else if(message.type === 'request_challenge') {
    const responseId = message.request_id + ':' + message.idp_id;
    common.handleChallengeRequest(responseId);
  }
  //consent request
  else {
    const valid = await common.checkRequestIntegrity(
      message.request_id,
      message
    );
    if (valid) {
      notifyIncomingRequestByCallback({
        mode: message.mode,
        request_id: message.request_id,
        namespace: message.namespace,
        identifier: message.identifier,
        request_message: message.request_message,
        request_message_hash: utils.hash(message.request_message),
        requester_node_id: message.rp_id,
        min_ial: message.min_ial,
        min_aal: message.min_aal,
        data_request_list: message.data_request_list,
      });
    }
  }
}

export async function handleTendermintNewBlockHeaderEvent(
  error,
  result,
  missingBlockCount
) {
  const height = tendermint.getBlockHeightFromNewBlockHeaderEvent(result);

  // messages that arrived before 'NewBlock' event
  // including messages between the start of missing block's height
  // and the block before latest block height
  // (not only just (current height - 1) in case 'NewBlock' events are missing)
  // NOTE: tendermint always create a pair of block. A block with transactions and
  // a block that signs the previous block which indicates that the previous block is valid
  const fromHeight =
    missingBlockCount == null
      ? 1
      : missingBlockCount === 0
        ? height - 1
        : height - missingBlockCount;
  const toHeight = height - 1;

  logger.debug({
    message: 'Getting request IDs to process',
    fromHeight,
    toHeight,
  });

  const requestIdsInTendermintBlock = await db.getRequestIdsExpectedInBlock(
    fromHeight,
    toHeight
  );
  await Promise.all(
    requestIdsInTendermintBlock.map(async (requestId) => {
      logger.debug({
        message: 'Processing request',
        requestId,
      });
      const message = await db.getRequestToProcessReceivedFromMQ(requestId);
      await db.removeRequestToProcessReceivedFromMQ(requestId);
      //reponse for onboard
      if(message.accessor_id) {
        if(await checkOnboardResponse(message)) {
          let { secret, associated } = await identity.addAccessorAfterConsent(message.request_id, message.accessor_id);
          let notifyData = {
            request_id: message.request_id,
            success: true,
            secret,
          };
          if(associated) notifyAddAccessorResultByCallback(notifyData);
          else notifyCreateIdentityResultByCallback(notifyData);
        }
      }
      else if(message.type === 'request_challenge') {
        const responseId = message.request_id + ':' + message.idp_id;
        common.handleChallengeRequest(responseId);
      }
      else {
        const valid = await common.checkRequestIntegrity(
          message.request_id,
          message
        );
        if (valid) {
          notifyIncomingRequestByCallback({
            mode: message.mode,
            request_id: message.request_id,
            namespace: message.namespace,
            identifier: message.identifier,
            request_message: message.request_message,
            request_message_hash: utils.hash(message.request_message),
            requester_node_id: message.rp_id,
            min_ial: message.min_ial,
            min_aal: message.min_aal,
            data_request_list: message.data_request_list,
          });
        }
      }
    })
  );

  db.removeRequestIdsExpectedInBlock(fromHeight, toHeight);
}

async function checkOnboardResponse(message) {
  let reason = false;
  let requestDetail = await tendermintNdid.getRequestDetail({
    requestId: message.request_id
  });
  let response = requestDetail.response_list[0];
  
  if(!(await common.verifyZKProof(message.request_id, message.idp_id, message, 3))) {
    reason = 'Invalid response';
  }
  else if(response.status !== 'accept') {
    reason = 'User rejected';
  }

  if(reason) {
    notifyAddAccessorResultByCallback({
      request_id: message.request_id,
      success: false,
    });

    logger.debug({
      message: 'Onboarding failed',
      reason,
    });

    db.removeChallengeFromRequestId(message.request_id);
    return false;
  }
  logger.debug({
    message: 'Onboard consented',
  });
  db.removeChallengeFromRequestId(message.request_id);
  return true;
}