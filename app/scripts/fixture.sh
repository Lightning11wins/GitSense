#!/bin/sh
# Creates a sample home dir with repos in several states, and prints its path.
# Usage: HOME=$(scripts/fixture.sh) scripts/drive.sh STEP...
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
home="$root/.dev/fixture/home"
rm -rf "$home"
mkdir -p "$home"
export HOME="$home" GIT_CONFIG_NOSYSTEM=1
git config --global user.name "Sample User"
git config --global user.email "sample@example.com"
git config --global init.defaultBranch main

repo() {
  mkdir -p "$home/$1"
  cd "$home/$1"
  git init -q
}

repo code/api
mkdir src
printf 'fn main() {\n    let name = "world";\n    println!("Hello, {name}!");\n}\n' > src/main.rs
printf '# API\n\nServes the things.\n' > README.md
printf 'old notes\n' > NOTES.md
git add . && git commit -q -m "Start the API."
printf 'fn main() {\n    let name = std::env::args().nth(1).unwrap_or("world".into());\n    println!("Hello, {name}!");\n}\n' > src/main.rs
printf 'pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n' > src/lib.rs
git add src/lib.rs
rm NOTES.md
printf 'scratch\n' > scratch.txt

repo code/web
printf 'export function greet(name: string) {\n  return `Hello, ${name}`;\n}\n' > index.ts
git add . && git commit -q -m "Start the web app."
printf 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n' > index.ts

echo "$home"
