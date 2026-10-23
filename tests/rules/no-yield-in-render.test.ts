import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-yield-in-render", {
  valid: [
    {
      name: "opaque client DoAsync stays conservative",
      code: dedent`
        local function YieldingEngineApis(props)
          local promise = props.client:DoAsync()
          return React.createElement("Frame")
        end
      `,
    },
    {
      name: "opaque cache GetAsync stays conservative",
      code: dedent`
        local function YieldingEngineApis(props)
          local custom = props.cache:GetAsync("key")
          return React.createElement("Frame")
        end
      `,
    },
  ],
  invalid: [
    {
      name: "render waits on a yielding API",
      code: dedent`
        local function Component(props)
          task.wait()
          return React.createElement("Frame")
        end
      `,
      errors: [
        { line: 2, column: 3, message: "task.wait can yield during component render." },
      ],
    },
    {
      name: "proven DataStore GetAsync yields",
      code: dedent`
        local DataStoreService = game:GetService("DataStoreService")
        local store = DataStoreService:GetDataStore("doctor-yield-test")
        local function YieldingEngineApis(props)
          local value = store:GetAsync("key")
          return React.createElement("Frame")
        end
      `,
      errors: [
        { line: 4, column: 17, message: "store:GetAsync can yield during component render." },
      ],
    },
    {
      name: "proven ContentProvider PreloadAsync yields",
      code: dedent`
        local ContentProvider = game:GetService("ContentProvider")
        local function YieldingEngineApis(props)
          ContentProvider:PreloadAsync({})
          return React.createElement("Frame")
        end
      `,
      errors: [
        { line: 3, column: 3, message: "ContentProvider:PreloadAsync can yield during component render." },
      ],
    },
  ],
});
