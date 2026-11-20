# GitSense

Read [DESIGN.md](DESIGN.md) before working on this project. It holds the agreed architecture, v1 scope, and build order. Changes to the design need the owner's agreement; record agreed changes there.

- Review flow: commit review. Commit each logical task to the current branch; never push.
- Builds, dev runs, and tests must work inside any git worktree without touching other checkouts (see "Worktree isolation" in DESIGN.md).
- The project will be published under the GPL. Keep secrets and anyone's personal setup (hostnames, paths) out of the tree.
- Use pnpm for Node tooling.
