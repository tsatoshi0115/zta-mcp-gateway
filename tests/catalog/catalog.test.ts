import { test, describe } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { CatalogProvider } from "../../src/catalog/index.js";

describe("CatalogProvider & Meta-Catalog MCP", () => {
  const definitionsFile = path.resolve("config/catalog-definitions.yaml.old");
  const provider = new CatalogProvider(definitionsFile);

  test("loads catalog definitions and returns tool definitions", () => {
    const tools = provider.getToolDefinitions();
    assert.strictEqual(tools.length, 2);
    assert.strictEqual(tools[0].name, "list_catalog");
    assert.strictEqual(tools[1].name, "get_catalog_detail");
  });

  test("listCatalog allows analyst role to see allowed catalogs", () => {
    const items = provider.listCatalog(["analyst"]);
    assert.strictEqual(items.length, 2);
    
    const npb = items.find((i) => i.id === "npb_baseball_analytics");
    assert.ok(npb);
    assert.strictEqual(npb.target_mcp, "mariadb");
    assert.strictEqual(npb.target_tool, "read_query");
    assert.strictEqual((npb as any).schema, undefined);
    assert.strictEqual((npb as any).gen_ui, undefined);

    const digitalAgency = items.find((i) => i.id === "digital_agency_procedures");
    assert.ok(digitalAgency);
    assert.strictEqual(digitalAgency.target_mcp, "admin-procedures");
    assert.strictEqual(digitalAgency.target_tool, "summarize_records");
    assert.strictEqual((digitalAgency as any).schema, undefined);
  });

  test("listCatalog allows admin role to see all catalogs", () => {
    const items = provider.listCatalog(["admin"]);
    assert.ok(items.length >= 1);
    const found = items.find((i) => i.id === "npb_baseball_analytics");
    assert.ok(found);
  });

  test("listCatalog hides catalogs for unauthorized role (guest) (Context Masking)", () => {
    const items = provider.listCatalog(["guest"]);
    assert.strictEqual(items.length, 0);
  });

  test("getCatalogDetail returns full schema and GenUI specification for authorized role", () => {
    const detail = provider.getCatalogDetail("npb_baseball_analytics", ["analyst"]);
    assert.strictEqual(detail.id, "npb_baseball_analytics");
    assert.ok(detail.schema);
    assert.ok(Array.isArray(detail.schema.tables));
    
    // Check tables
    const tableNames = detail.schema.tables.map((t) => t.name);
    assert.ok(tableNames.includes("batting_stats"));
    assert.ok(tableNames.includes("pitching_stats"));
    assert.ok(tableNames.includes("players"));

    // Check GenUI specifications
    assert.ok(detail.gen_ui);
    assert.strictEqual(detail.gen_ui.recommended_layout, "ComparisonDashboard");
    assert.strictEqual(detail.gen_ui.framework, "TailwindCSS + Chart.js");
    assert.ok(Array.isArray(detail.gen_ui.components));
    
    const chartComponent = detail.gen_ui.components.find((c) => c.type === "chart");
    assert.ok(chartComponent);
    assert.strictEqual(chartComponent.chart_type, "bar");
    assert.strictEqual(chartComponent.x_axis, "name");
    assert.strictEqual(chartComponent.y_axis, "war");

    const detailCard = detail.gen_ui.components.find((c) => c.type === "detail_card");
    assert.ok(detailCard);
  });

  test("getCatalogDetail returns full schema and GenUI for digital_agency_procedures", () => {
    const detail = provider.getCatalogDetail("digital_agency_procedures", ["analyst"]);
    assert.strictEqual(detail.id, "digital_agency_procedures");
    assert.ok(detail.schema);
    assert.ok(Array.isArray(detail.schema.datasets));
    assert.strictEqual(detail.schema.datasets[0].id, "procedures-survey-r7");
    assert.ok(detail.gen_ui);
    assert.strictEqual(detail.gen_ui.recommended_layout, "AdministrativeReformDashboard");
    assert.strictEqual(detail.gen_ui.framework, "TailwindCSS + Chart.js");
  });

  test("getCatalogDetail denies access for unauthorized role", () => {
    assert.throws(
      () => {
        provider.getCatalogDetail("npb_baseball_analytics", ["guest"]);
      },
      (err: any) => {
        return err.message.includes("forbidden by ZTA policy");
      }
    );
  });

  test("getCatalogDetail throws error for non-existent service ID", () => {
    assert.throws(
      () => {
        provider.getCatalogDetail("unknown_service_id", ["admin"]);
      },
      (err: any) => {
        return err.message.includes("not found");
      }
    );
  });
});
