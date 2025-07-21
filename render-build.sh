#!/bin/bash
set -e

npm install -g rimraf @types/jest vite @microsoft/api-extractor @microsoft/api-documenter ts-node
npm ci
npm install --no-save @types/jest vite
npm --workspace packages/core install --no-save @types/jest vite
npx turbo run build --filter=@medplum/server
