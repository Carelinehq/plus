#!/bin/bash
set -e

echo "Installing global tools…"
npm install -g rimraf @types/jest vite @types/node \
  @microsoft/api-extractor @microsoft/api-documenter ts-node

echo "Running npm ci…"
npm ci

echo "Installing root‑level extra types…"
npm install --no-save @types/jest vite @types/node

echo "Installing extra types inside packages/core…"
npm --workspace packages/core install --no-save @types/jest vite @types/node

echo "Running turbo build…"
npx turbo run build --filter=@medplum/server
