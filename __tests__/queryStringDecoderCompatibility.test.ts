import decodeUriComponent from "decode-uri-component";
import queryString from "query-string";

describe("Router query decoder compatibility", () => {
  it("preserves literal and encoded plus in query keys, values and fragments", () => {
    expect(queryString.parse("a+b=c+d&encoded=%2B&double=%252B")).toEqual({
      "a b": "c d",
      encoded: "+",
      double: "%2B",
    });
    expect(
      queryString.parseUrl("airmesh://trip#literal+%2B", {
        parseFragmentIdentifier: true,
      }).fragmentIdentifier,
    ).toBe("literal +");
    expect(queryString.parse("a+b=%2B", { decode: false })).toEqual({
      "a+b": "%2B",
    });
  });

  it("keeps arrays, nulls, empty values and valid Unicode", () => {
    expect(queryString.parse("x=%F0%9F%98%80&x=%C3%A5&flag&empty=")).toEqual({
      x: ["😀", "å"],
      flag: null,
      empty: "",
    });
    expect(
      queryString.parse("x[]=a&x[]=b", { arrayFormat: "bracket" }),
    ).toEqual({ x: ["a", "b"] });
    expect(
      queryString.parse("n=42&yes=true", {
        parseNumbers: true,
        parseBooleans: true,
      }),
    ).toEqual({ n: 42, yes: true });
    expect(
      queryString.parse(queryString.stringify({ value: "a+b c😀" })),
    ).toEqual({ value: "a+b c😀" });
  });

  it.each([
    ["%C3%A5%zz", "å%zz"],
    ["%C2", "�"],
    ["%FE%FF", "��"],
    ["%E0%80%80", "%E0%80%80"],
    ["%F4%90%80%80", "%F4%90%80%80"],
    ["%25C2%zz", "%C2%zz"],
    ["%25%41%zz", "%A%zz"],
    ["%84%D7%25%88%90", "%84%D7%%88%90"],
  ])("uses fixed single-pass decoding for %s", (encoded, expected) => {
    expect(decodeUriComponent(encoded)).toBe(expected);
    expect(queryString.parse(`x=${encoded}`).x).toBe(expected);
  });
});
