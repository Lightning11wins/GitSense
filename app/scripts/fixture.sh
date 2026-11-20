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
git init -q --bare "$home/remotes/web.git"
git remote add origin "$home/remotes/web.git"
git push -q -u origin main
git switch -q -c release
printf 'v1\n' > VERSION
git add VERSION && git commit -q -m "Prepare the release."
git push -q origin release
git switch -q main
git branch -q -D release
git switch -q -c feature/login
printf 'export const login = () => true;\n' > login.ts
git add login.ts && git commit -q -m "Add login."
git switch -q main
printf 'node_modules/\n' > .gitignore
git add .gitignore && git commit -q -m "Ignore dependencies."
git worktree add -q -b agent "$home/code/web-agent"
printf 'agent\n' > "$home/code/web-agent/AGENT.md"
git -C "$home/code/web-agent" add AGENT.md
git -C "$home/code/web-agent" commit -q -m "Add agent notes."
printf 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n' > index.ts

echo "$home"
