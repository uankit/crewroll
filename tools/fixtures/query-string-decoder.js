const queryString = require("query-string");
const decode = require("decode-uri-component").default;

// This probe executes inside Metro's production module factories on both native
// platforms. Keep literal plus distinct from a percent-encoded plus.
exports.parsed = queryString.parse(
  "literal=a+b&encoded=%2B&unicode=%F0%9F%98%80&bad=%C3%A5%zz&once=%25C2%zz&repeat=1&repeat=2&flag&empty=",
);
exports.fragment = queryString.parseUrl("airmesh://trip#literal+%2B", {
  parseFragmentIdentifier: true,
}).fragmentIdentifier;
exports.raw = queryString.parse("a+b=%2B", { decode: false });
exports.fixed = decode("%25C2%zz");
exports.roundTrip = queryString.parse(
  queryString.stringify({ name: "a+b c", emoji: "😀" }),
);
