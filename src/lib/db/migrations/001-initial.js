import { TABLES, buildCreateTableSql, buildCreateTableSqlPg } from "../schema.js";

export default {
  version: 1,
  name: "initial",
  async up(db) {
    const buildSql = db.isPg ? buildCreateTableSqlPg : buildCreateTableSql;
    for (const [name, def] of Object.entries(TABLES)) {
      await db.exec(buildSql(name, def));
      for (const idx of def.indexes || []) await db.exec(idx);
    }
  },
};
