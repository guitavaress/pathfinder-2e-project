import { describe, expect, it } from "vitest";
import { degreeOfSuccess, rollCheck } from "./check.js";

describe("degreeOfSuccess", () => {
  it("aplica a margem de 10", () => {
    // die 10 (não é 1 nem 20) para isolar a regra base.
    expect(degreeOfSuccess(10, 25, 15)).toBe("criticalSuccess"); // >= DC+10
    expect(degreeOfSuccess(10, 16, 15)).toBe("success"); // >= DC
    expect(degreeOfSuccess(10, 14, 15)).toBe("failure"); // < DC
    expect(degreeOfSuccess(10, 5, 15)).toBe("criticalFailure"); // <= DC-10
  });

  it("nat 20 sobe um grau", () => {
    expect(degreeOfSuccess(20, 16, 15)).toBe("criticalSuccess"); // success -> crit
    expect(degreeOfSuccess(20, 14, 15)).toBe("success"); // failure -> success
  });

  it("nat 1 desce um grau", () => {
    expect(degreeOfSuccess(1, 16, 15)).toBe("failure"); // success -> failure
    expect(degreeOfSuccess(1, 25, 15)).toBe("success"); // crit -> success
  });

  it("nat 20 num crit success continua crit; nat 1 numa crit failure continua crit failure", () => {
    expect(degreeOfSuccess(20, 30, 15)).toBe("criticalSuccess");
    expect(degreeOfSuccess(1, 1, 15)).toBe("criticalFailure");
  });
});

describe("rollCheck", () => {
  it("usa o rng injetado e calcula o total", () => {
    // rng retorna 0.5 -> floor(0.5*20)+1 = 11
    const result = rollCheck("Deception vs DC 18", 10, 18, () => 0.5);
    expect(result.die).toBe(11);
    expect(result.total).toBe(21);
    expect(result.degree).toBe("success");
  });
});
