import { expect, test } from "bun:test"
import { CodeModeDisplayInput } from "../src/codemode/display-input"

test("small JSON input keeps its display shape but owns its objects", () => {
  const input = { path: "/tmp/中文图片.png", nested: { count: 2, enabled: true }, values: [null,"x"] }
  const shown=CodeModeDisplayInput.summarize(input)!
  expect(shown).toEqual(input)
  expect(shown).not.toBe(input)
  expect(shown.nested).not.toBe(input.nested)
  expect(shown.values).not.toBe(input.values)
  input.nested.count=9
  input.values.push("later")
  expect(shown.nested).toEqual({count:2,enabled:true})
  expect(shown.values).toEqual([null,"x"])
  expect(CodeModeDisplayInput.summarize({})).toBeUndefined()
  expect(CodeModeDisplayInput.summarize(null)).toBeUndefined()
  expect(CodeModeDisplayInput.summarize(undefined)).toBeUndefined()
  expect(CodeModeDisplayInput.summarize([1,2])).toEqual({input:[1,2]})
  expect(CodeModeDisplayInput.summarize("small")).toEqual({input:"small"})
})

test("large binary and ordinary strings are summarized without changing the input", () => {
  const huge="A".repeat(1024*1024)
  const input=Object.freeze({ base64:huge, nested:Object.freeze({uri:"data:image/png;base64,"+huge}), title:"中文图片.png", text:"文".repeat(2000) })
  const shown=CodeModeDisplayInput.summarize(input)!
  expect(shown.base64).toBe("[string omitted: 1048576 code units]")
  expect(shown.title).toBe("中文图片.png")
  expect(JSON.stringify(shown)).not.toContain("data:image/png;base64,")
  expect(Buffer.byteLength(JSON.stringify(shown))).toBeLessThanOrEqual(CodeModeDisplayInput.MaxBytes)
  expect(input.base64).toBe(huge)
  expect(input.nested.uri).toBe("data:image/png;base64,"+huge)
})

test("deep, wide and escaped inputs are bounded and omissions are explicit", () => {
  const cases=[
    {nested:{a:{b:{c:{d:{base64:"x".repeat(1000)}}}}}},
    {list:Array.from({length:1000},(_,i)=>({i,text:"中文".repeat(128)}))},
    Object.fromEntries(Array.from({length:1000},(_,i)=>["key"+i,"x".repeat(256)])),
    Object.fromEntries(Array.from({length:16},(_,i)=>["控制".repeat(50)+i,"\u0000".repeat(256)])),
    {["long-key".repeat(1000)]:"value"},
  ]
  for(const value of cases){
    const result=JSON.stringify(CodeModeDisplayInput.summarize(value))
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(CodeModeDisplayInput.MaxBytes)
    expect(result).toContain("omitted")
  }
})

test("special object keys remain ordinary data and omission marker does not overwrite a field", () => {
  const input=JSON.parse('{"__proto__":{"polluted":true},"constructor":"ordinary"}')
  const shown=CodeModeDisplayInput.summarize(input)!
  expect(Object.hasOwn(shown,"__proto__")).toBe(true)
  expect(Object.getPrototypeOf(shown)).toBe(Object.prototype)
  expect(Object.getOwnPropertyDescriptor(shown,"constructor")?.value).toBe("ordinary")
  const wide=Object.fromEntries([["[more fields omitted]","preserved"],...Array.from({length:20},(_,i)=>["k"+i,i])])
  expect(CodeModeDisplayInput.summarize(wide)!["[more fields omitted]"]).toBe("preserved")
  expect(CodeModeDisplayInput.summarize(wide)!["[more fields omitted]."]).toBe(true)
})
