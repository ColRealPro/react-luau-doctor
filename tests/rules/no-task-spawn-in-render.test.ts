import { dedent, ruleTester } from "../helpers/rule-tester";

ruleTester("react-luau/no-task-spawn-in-render", {
  valid: [
    {
      name: "uncalled helper may spawn deferred work",
      code: dedent`
        local function BuildObject()
          local folder = Instance.new("Folder")
          task.spawn(function() folder.Name = "Built" end)
          return folder
        end
        local function Component(props)
          return React.createElement("Frame")
        end
      `,
    },
  ],
  invalid: [
    {
      name: "render spawns a task",
      code: dedent`
        local function Component(props)
          task.spawn(function() print("work") end)
          return React.createElement("Frame")
        end
      `,
      errors: [
        { line: 2, column: 3, message: "task.spawn schedules work during component render." },
      ],
    },
  ],
});
