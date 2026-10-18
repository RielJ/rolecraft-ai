import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PanelScreens, SCREENS } from "../src/panel/App";

// Where the paired panel puts its parts (App.tsx). The applied question must show on every tab:
// an answer the user never sees is no better than no question.

const windows: Window[] = [];

afterEach(async () => {
  await Promise.all(windows.splice(0).map((w) => w.happyDOM.close()));
});

function render(screen: (typeof SCREENS)[number]["id"]) {
  const markup = renderToStaticMarkup(
    createElement(PanelScreens, {
      screen,
      prompt: createElement("p", { id: "prompt" }, "Did you submit this application?"),
      application: createElement("p", { id: "application" }, "Review"),
      importScreen: createElement("p", { id: "import" }, "Import"),
      diagnostics: createElement("p", { id: "diagnostics" }, "Diagnostics"),
    }),
  );
  const window = new Window();
  windows.push(window);
  const document = new window.DOMParser().parseFromString(markup, "text/html");
  const shown = (id: string): boolean | null => {
    const element = document.getElementById(id);
    return element === null ? null : element.closest("[hidden]") === null;
  };
  return { shown };
}

describe("panel layout", () => {
  test("the applied question shows whichever tab is open", () => {
    for (const { id } of SCREENS) expect(render(id).shown("prompt")).toBe(true);
  });

  test("Application and Import stay mounted while hidden; only the open tab shows", () => {
    const onImport = render("import");
    expect(onImport.shown("application")).toBe(false);
    expect(onImport.shown("import")).toBe(true);
    expect(onImport.shown("diagnostics")).toBeNull();

    const onApplication = render("application");
    expect(onApplication.shown("application")).toBe(true);
    expect(onApplication.shown("import")).toBe(false);

    const onDiagnostics = render("diagnostics");
    expect(onDiagnostics.shown("diagnostics")).toBe(true);
    expect(onDiagnostics.shown("application")).toBe(false);
  });
});
