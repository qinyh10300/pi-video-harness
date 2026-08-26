import type { ImageToVideoPlan } from "@pi-video-harness/contracts";

import { canonicalJson } from "./canonical-json.js";
import { RecordConflictError, RecordNotFoundError } from "./errors.js";
import {
  decodeJson,
  encodeJson,
  positiveInteger,
  RepositoryBase,
} from "./repository-helpers.js";

interface PlanRow {
  plan_id: string;
  plan_version: number | bigint;
  plan_hash: string;
  data_json: string;
  created_at: string;
}

export class PlansRepository extends RepositoryBase {
  create<TPlan extends ImageToVideoPlan>(plan: TPlan): TPlan {
    positiveInteger(plan.planVersion, "planVersion");
    const existing = this.get<TPlan>(plan.planId, plan.planVersion);
    if (existing !== undefined) {
      if (canonicalJson(existing) === canonicalJson(plan)) {
        return existing;
      }
      throw new RecordConflictError(
        "plan",
        `${plan.planId}@${plan.planVersion}`,
      );
    }

    this.database.run(
      `INSERT INTO plans
         (plan_id, plan_version, plan_hash, data_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      plan.planId,
      plan.planVersion,
      plan.planHash,
      encodeJson(plan),
      plan.createdAt,
    );
    return plan;
  }

  get<TPlan extends ImageToVideoPlan = ImageToVideoPlan>(
    planId: string,
    planVersion?: number,
  ): TPlan | undefined {
    const row =
      planVersion === undefined
        ? this.database.queryOne<PlanRow>(
            `SELECT * FROM plans
             WHERE plan_id = ?
             ORDER BY plan_version DESC
             LIMIT 1`,
            planId,
          )
        : this.database.queryOne<PlanRow>(
            "SELECT * FROM plans WHERE plan_id = ? AND plan_version = ?",
            planId,
            planVersion,
          );
    return row === undefined ? undefined : decodeJson<TPlan>(row.data_json);
  }

  getRequired<TPlan extends ImageToVideoPlan = ImageToVideoPlan>(
    planId: string,
    planVersion?: number,
  ): TPlan {
    const plan = this.get<TPlan>(planId, planVersion);
    if (plan === undefined) {
      throw new RecordNotFoundError(
        "plan",
        planVersion === undefined ? planId : `${planId}@${planVersion}`,
      );
    }
    return plan;
  }

  getByHash<TPlan extends ImageToVideoPlan = ImageToVideoPlan>(
    planId: string,
    planHash: string,
  ): TPlan | undefined {
    const row = this.database.queryOne<PlanRow>(
      "SELECT * FROM plans WHERE plan_id = ? AND plan_hash = ?",
      planId,
      planHash,
    );
    return row === undefined ? undefined : decodeJson<TPlan>(row.data_json);
  }

  listVersions<TPlan extends ImageToVideoPlan = ImageToVideoPlan>(
    planId: string,
  ): TPlan[] {
    return this.database
      .queryAll<PlanRow>(
        "SELECT * FROM plans WHERE plan_id = ? ORDER BY plan_version",
        planId,
      )
      .map((row) => decodeJson<TPlan>(row.data_json));
  }
}
