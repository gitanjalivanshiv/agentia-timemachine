# agentia-plugin-timemachine

Template versioning for Copado Release Data Templates: snapshot, diff, safe edit and restore

After install or link, it adds:

```text
agentia timemachine status [NAME] [--from VALUE]
```

## Getting started

If you created this plugin with `npm init @copado/agentia-plugin`, dependencies are already installed.

```sh
npm run build
agentia plugins link .
```

Confirm:

```sh
agentia plugins
agentia timemachine status
agentia timemachine status World --from me
```

Re-run `npm run build` after TypeScript changes. Linked ESM plugins load compiled `dist/` output.

## Install from npm

```sh
agentia plugins install agentia-plugin-timemachine
```

## What plugins can do today

- Add new commands (`agentia <topic> <command>`)
- Use oclif flags, args, and standard command lifecycle
- Link or install like any other oclif plugin

## Not supported yet

- Calling Agentia CLI internals (auth, org/context, work items, git, and similar host services)
- Extending or wrapping existing Agentia commands (`cicd work commit`, and so on)
- Registering MCP tools through a plugin (`agentia mcp start` only loads tools shipped with the CLI)

A first-party API for selected CLI integration points is planned. Do not
depend on private Agentia source paths in the meantime.

## Layout

```text
agentia-plugin-timemachine/
  package.json
  tsconfig.json
  src/
    index.ts
    commands/
      timemachine/
        status.ts
  dist/
```

Generated with `npm init @copado/agentia-plugin`.
