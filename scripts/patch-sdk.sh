#!/bin/sh
# Silence debug console.log statements in flash-sdk
# These are development artifacts left in the published package.
# This script runs as a postinstall hook to keep the terminal output clean.

SDK_FILE="node_modules/flash-sdk/dist/PerpetualsClient.js"

if [ ! -f "$SDK_FILE" ]; then
  exit 0
fi

node -e "
const fs = require('fs');
const f = '$SDK_FILE';
let src = fs.readFileSync(f, 'utf8');
const patterns = [
  'close position :::',
  'SDK logs :',
  'volitlity fee',
  'assetsUsd',
  'maxWithdrawableAmount',
  'collateralAmountReceived',
  'exceeding to',
  'profitLoss',
  'THIS cannot',
  'collateralSymbol === SOL',
  'inputSymbol === SOL',
];
for (const p of patterns) {
  src = src.split('console.log(\"' + p).join('// console.log(\"' + p);
  src = src.split(\"console.log('\" + p).join(\"// console.log('\" + p);
}
fs.writeFileSync(f, src);
"
