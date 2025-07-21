#!/bin/bash

# Make sure the script has execute permissions:
# chmod +x render-build.sh

echo "Installing global tools..."
npm install -g rimraf @types/jest vite @microsoft/api-extractor @microsoft/api-documenter ts-node

echo "Running npm ci..."
npm ci

echo "Installing additional dependencies..."
npm install --no-save @types/jest vite

echo "Installing core workspace deps..."
npm --workspace packages/core install --no-save @types/jest vite

echo "Running turbo build..."
npx turbo run build --filter=@medplum/server
