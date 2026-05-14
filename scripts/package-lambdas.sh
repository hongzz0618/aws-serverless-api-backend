#!/usr/bin/env bash
set -euo pipefail

script_path="${BASH_SOURCE[0]}"
script_dir_path="${script_path%/*}"
if [[ "$script_dir_path" == "$script_path" ]]; then
  script_dir_path="."
fi

script_dir="$(cd -- "$script_dir_path" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
lambda_dir="$repo_root/lambdas"
package_tmp_dir="$lambda_dir/.package-tmp"
package_prod_dir="$lambda_dir/.package-prod"

required_files=(
  "createItem.ts"
  "getItem.ts"
  "deleteItem.ts"
  "package.json"
  "package-lock.json"
  "tsconfig.json"
)

handlers=(
  "dist/createItem.js:createItem.zip"
  "dist/getItem.js:getItem.zip"
  "dist/deleteItem.js:deleteItem.zip"
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

if [[ ! -d "src" ]]; then
  echo "Error: Required directory is missing: src" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required but was not found on PATH." >&2
  exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "Error: zip is required but was not found on PATH." >&2
  exit 1
fi

echo "Installing Lambda dependencies..."
npm ci

if [[ ! -d "node_modules" ]]; then
  echo "Error: node_modules was not created. Dependency installation may have failed." >&2
  exit 1
fi

echo "Compiling TypeScript Lambda handlers..."
npm run build

for handler_package in "${handlers[@]}"; do
  handler="${handler_package%%:*}"
  if [[ ! -f "$handler" ]]; then
    echo "Error: Compiled handler is missing: $handler" >&2
    exit 1
  fi
done

echo "Removing old Lambda packages..."
rm -f createItem.zip getItem.zip deleteItem.zip
rm -rf "$package_tmp_dir"
rm -rf "$package_prod_dir"
mkdir -p "$package_tmp_dir"
mkdir -p "$package_prod_dir"

cleanup() {
  rm -rf "$package_tmp_dir"
  rm -rf "$package_prod_dir"
}
trap cleanup EXIT

echo "Installing production dependencies for Lambda packages..."
cp package.json package-lock.json "$package_prod_dir/"
(
  cd "$package_prod_dir"
  npm ci --omit=dev
)

for handler_package in "${handlers[@]}"; do
  handler="${handler_package%%:*}"
  package="${handler_package##*:}"
  handler_file="${handler##*/}"

  echo "Creating package: $package"
  rm -rf "$package_tmp_dir"/*
  cp "$handler" "$package_tmp_dir/$handler_file"
  cp -R dist/src "$package_tmp_dir/src"
  cp package.json package-lock.json "$package_tmp_dir/"
  cp -R "$package_prod_dir/node_modules" "$package_tmp_dir/"

  (
    cd "$package_tmp_dir"
    zip -qr "$lambda_dir/$package" "$handler_file" src package.json package-lock.json node_modules
  )
done

echo "Lambda packages created successfully:"
for handler_package in "${handlers[@]}"; do
  package="${handler_package##*:}"
  echo " - $lambda_dir/$package"
done
