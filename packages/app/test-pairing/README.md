# Pairing component regression

Run from `packages/app` after the repository's frozen dependency install:

```sh
bun test --conditions=browser --preload ./test-pairing/solid-preload.ts --preload ./happydom.ts ./test-pairing/settings-pairing.test.ts
```

This scoped test compiles the real Solid DOM implementation and exercises the generated HTTP client. It protects explicit request admission, target changes, clearing and owner disposal without any live service.

The upstream Bun 1.4.4 hyperscript preload drops the automatically generated JSX runtime import in real context-provider components. Keeping this test and its real Solid compiler preload separate avoids changing the shared harness or adding a failing case to the default browser suite. The pure state-machine tests remain in the normal unit-test tree.
