#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
lambda_dir="$repo_root/lambdas"

required_files=(
  "createItem.js"
  "getItem.js"
  "deleteItem.js"
  "package.json"
  "package-lock.json"
)

handlers=(
  "createItem.js:createItem.zip"
  "getItem.js:getItem.zip"
  "deleteItem.js:deleteItem.zip"
)

echo "Packaging Lambda functions..."
echo "Repository root: $repo_root"
echo "Lambda directory: $lambda_dir"

if [[ ! -d "$lambda_dir" ]]; then
  echo "Error: Lambda directory not found: $lambda_dir" >&2
  exit 1
fi

cd "$lambda_dir"

for file in "${required_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "Error: Required file is missing: $file" >&2
    exit 1
  fi
done

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required but was not found on PATH." >&2
  exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "Error: zip is required but was not found on PATH." >&2
  exit 1
fi

echo "Installing Lambda dependencies..."
if [[ -f "package-lock.json" ]]; then
  npm ci
else
  npm install
fi

if [[ ! -d "node_modules" ]]; then
  echo "Error: node_modules was not created. Dependency installation may have failed." >&2
  exit 1
fi

echo "Removing old Lambda packages..."
rm -f createItem.zip getItem.zip deleteItem.zip

for handler_package in "${handlers[@]}"; do
  handler="${handler_package%%:*}"
  package="${handler_package##*:}"

  echo "Creating package: $package"
  zip -r "$package" "$handler" package.json package-lock.json node_modules
done

echo "Lambda packages created successfully:"
for handler_package in "${handlers[@]}"; do
  package="${handler_package##*:}"
  echo " - $lambda_dir/$package"
done
