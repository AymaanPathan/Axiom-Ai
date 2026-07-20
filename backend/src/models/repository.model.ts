import mongoose, { Schema, Document } from "mongoose";
import type { DiscoveredRoute } from "../parsing/route-parser.js";

export interface RepositoryDoc extends Document {
  userId: string; // github user id
  githubFullName: string;
  defaultBranch: string;
  localPath: string;
  discoveredRoutes: DiscoveredRoute[];
  framework: string;
  connectedAt: Date;
  instrumentationGeneratedAt?: Date;
  requiredEnvVars: string[];
  envVars: {
    key: string;
    ciphertext: string;
    iv: string;
    authTag: string;
  }[];
  appPort: number;
}

const RouteSchema = new Schema<DiscoveredRoute>(
  {
    method: { type: String, required: true },
    routePath: { type: String, required: true },
    file: { type: String, required: true },
    line: { type: Number, required: true },
  },
  { _id: false },
);

const RepositorySchema = new Schema<RepositoryDoc>({
  userId: { type: String, required: true, index: true },
  githubFullName: { type: String, required: true },
  defaultBranch: { type: String, required: true },
  localPath: { type: String, required: true },
  discoveredRoutes: { type: [RouteSchema], default: [] },
  framework: { type: String, default: "unknown" },
  connectedAt: { type: Date, default: Date.now },
  instrumentationGeneratedAt: { type: Date },
  requiredEnvVars: { type: [String], default: [] },
  envVars: {
    type: [
      {
        key: { type: String, required: true },
        ciphertext: { type: String, required: true },
        iv: { type: String, required: true },
        authTag: { type: String, required: true },
      },
    ],
    default: [],
  },
  appPort: { type: Number, default: 3000 },
});

export const RepositoryModel = mongoose.model<RepositoryDoc>(
  "Repository",
  RepositorySchema,
);
