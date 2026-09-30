import { describe, expect, it } from "vitest";
import { PeopleIndex, findDuplicatePairs, nameKey } from "./people";

describe("nameKey", () => {
  it("ignora mayúsculas, tildes y espacios", () => {
    expect(nameKey("  Ána  GARCÍA ")).toBe("ana garcia");
  });
});

describe("findDuplicatePairs", () => {
  const p = (id: string, name: string, extra = {}) => ({ id, name, ...extra });

  it("detecta nombre contenido, errores de transcripción, alias y email", () => {
    const pairs = findDuplicatePairs([
      p("1", "Ana García", { company: "ACME" }),
      p("2", "Ana"),
      p("3", "Ana Garsia", { company: "ACME" }),
      p("4", "Luis Pérez", { email: "luis@acme.com" }),
      p("5", "L. Pérez", { email: "LUIS@acme.com" }),
      p("6", "Marta", { aliases: ["Marta Ruiz"] }),
      p("7", "Marta Ruiz"),
      p("8", "Anabel"),
    ]);
    const has = (a: string, b: string) => pairs.find((x) => x.a === a && x.b === b)?.reason;
    expect(has("1", "2")).toBe("Un nombre contiene al otro");
    expect(has("1", "3")).toBe("Nombre muy parecido");
    expect(has("4", "5")).toBe("Mismo email");
    expect(has("6", "7")).toBe("Mismo nombre");
    expect(has("2", "8")).toBeUndefined(); // "Ana" no es "Anabel"
  });

  it("no mezcla personas del mismo nombre en empresas distintas", () => {
    expect(findDuplicatePairs([
      p("1", "Ana García", { company: "ACME" }), p("2", "Ana García", { company: "Globex" }),
    ])).toEqual([]);
  });
});

describe("PeopleIndex", () => {
  it("resuelve por nombre completo, alias y nombre de pila único", () => {
    const idx = new PeopleIndex();
    idx.add({ id: 1, name: "Ana García" }, "Anita");
    idx.add({ id: 2, name: "Luis Pérez" });
    expect(idx.find("ana garcia")?.id).toBe(1);
    expect(idx.find("Anita")?.id).toBe(1);
    expect(idx.find("Luis")?.id).toBe(2);
    expect(idx.find("Pedro")).toBeUndefined();
  });
});
