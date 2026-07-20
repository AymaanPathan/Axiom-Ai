import { Schema, model } from "mongoose";

export type RunStatus =
  | "starting"
  | "installing"
  | "running"
  | "exited"
  | "error";

const runSchema = new Schema(
  {
    repositoryId: {
      type: Schema.Types.ObjectId,
      ref: "Repository",
      required: true,
      index: true,
    },
    userId: { type: String, required: true },
    status: {
      type: String,
      enum: ["starting", "installing", "running", "exited", "error"],
      default: "starting",
    },
    port: { type: Number },
    containerId: { type: String },
    exitCode: { type: Number },
    errorMessage: { type: String },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date },
  },
  { timestamps: true },
);

export const RunModel = model("Run", runSchema);
