// NightFleet on-chain client: deploy a squad game, join one from a squad
// link, and call the five game circuits - everything through the connected
// wallet, so the chain holds the state and the browser holds the secrets.
//
// The compiled contract is imported from the gitignored contract/managed
// build; `npm run compile` in contract/ produces it (see the README).

import { Contract } from '../vendor/nightfleet-contract/index.js';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import {
  createUnprovenDeployTx,
  submitTxAsync,
  findDeployedContract,
  submitCallTxAsync,
} from '@midnight-ntwrk/midnight-js-contracts';

export const CONTRACT_TAG = 'nightfleet';
export const PRIVATE_STATE_ID = 'nightfleet';

/** A fresh seat's secrets: secret key, board salt, empty board. */
export function freshPrivateState() {
  return { sk: new Uint8Array(32), salt: new Uint8Array(32), board: Array(64).fill(0n) };
}

const witnesses = {
  localSecretKey: (ctx) => [ctx.privateState, ctx.privateState.sk],
  myBoard: (ctx) => [ctx.privateState, ctx.privateState.board],
  mySalt: (ctx) => [ctx.privateState, ctx.privateState.salt],
};

/** The compiled contract binding, with NightFleet's witnesses attached. */
export function nightfleetCompiled() {
  return CompiledContract.make(CONTRACT_TAG, Contract).withWitnesses(witnesses);
}

/**
 * Deploy a fresh NightFleet contract and return its on-chain address.
 * The address is only known once the transaction is built; confirmation is
 * the indexer's job (query contractAction for ContractDeploy).
 */
export async function deployNightfleet(providers) {
  const compiledContract = nightfleetCompiled();
  const deployTxData = await createUnprovenDeployTx(providers, {
    compiledContract,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: freshPrivateState(),
  });
  const contractAddress = deployTxData.public.contractAddress;
  await submitTxAsync(providers, { unprovenTx: deployTxData.private.unprovenTx });
  await providers.privateStateProvider.set(PRIVATE_STATE_ID, freshPrivateState());
  await providers.privateStateProvider.setSigningKey(contractAddress, deployTxData.private.signingKey);
  return contractAddress;
}

/** Bind to a game that already exists on-chain (the joiner's path). */
export async function findNightfleet(providers, contractAddress) {
  return findDeployedContract(providers, {
    contractAddress,
    compiledContract: nightfleetCompiled(),
    privateStateId: PRIVATE_STATE_ID,
  });
}

/**
 * Call one of the game circuits and return the submitted transaction.
 * `args` matches the circuit's parameter order (e.g. fire takes [x, y]).
 */
export async function callCircuit(providers, contractAddress, circuitId, args = []) {
  return submitCallTxAsync(providers, {
    compiledContract: nightfleetCompiled(),
    contractAddress,
    circuitId,
    args,
    privateStateId: PRIVATE_STATE_ID,
  });
}

export const joinGame = (providers, address) => callCircuit(providers, address, 'joinGame');
export const commitBoard = (providers, address) => callCircuit(providers, address, 'commitBoard');
export const fire = (providers, address, x, y) => callCircuit(providers, address, 'fire', [x, y]);
export const report = (providers, address) => callCircuit(providers, address, 'report');
export const claimWin = (providers, address) => callCircuit(providers, address, 'claimWin');
export const startTimeout = (providers, address, deadline) => callCircuit(providers, address, 'startTimeout', [deadline]);
export const claimTimeout = (providers, address) => callCircuit(providers, address, 'claimTimeout');
export const revealBoard = (providers, address) => callCircuit(providers, address, 'revealBoard');
