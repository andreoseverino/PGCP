import assert from "node:assert/strict";
import { test } from "node:test";
import { enderecoDoDiretorio } from "./corporate-email";

test("resolver do diretório prioriza mail válido", () => {
  assert.equal(
    enderecoDoDiretorio({ mail: "caixa@empresa.com", userPrincipalName: "login@empresa.com" }),
    "caixa@empresa.com",
  );
});

test("resolver do diretório usa UPN quando mail está ausente ou inválido", () => {
  assert.equal(
    enderecoDoDiretorio({ mail: null, userPrincipalName: "login@empresa.com" }),
    "login@empresa.com",
  );
  assert.equal(
    enderecoDoDiretorio({ mail: "inválido", userPrincipalName: "login@empresa.com" }),
    "login@empresa.com",
  );
});

test("resolver do diretório não inventa endereço", () => {
  assert.equal(
    enderecoDoDiretorio({ mail: "inválido", userPrincipalName: "também-inválido" }),
    undefined,
  );
});
