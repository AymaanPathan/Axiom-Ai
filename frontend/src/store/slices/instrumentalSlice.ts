import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import {
  generateInstrumentation,
  type InstrumentationResult,
} from "../../api/instrumentation";

type InstrumentationStatus = "idle" | "preparing" | "ready" | "error";

interface RepoInstrumentationState {
  status: InstrumentationStatus;
  result: InstrumentationResult | null;
  error: string | null;
}

interface InstrumentationState {
  byRepositoryId: Record<string, RepoInstrumentationState>;
}

const initialState: InstrumentationState = {
  byRepositoryId: {},
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A real "analyzing your repo" moment should never resolve instantly even if
// the backend is fast — 1.4s minimum keeps the preparing checklist visible
// long enough to read.
export const runInstrumentation = createAsyncThunk(
  "instrumentation/run",
  async (repositoryId: string) => {
    const [result] = await Promise.all([
      generateInstrumentation(repositoryId),
      sleep(1400),
    ]);
    return { repositoryId, result };
  },
);

const instrumentationSlice = createSlice({
  name: "instrumentation",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(runInstrumentation.pending, (state, action) => {
        state.byRepositoryId[action.meta.arg] = {
          status: "preparing",
          result: null,
          error: null,
        };
      })
      .addCase(runInstrumentation.fulfilled, (state, action) => {
        state.byRepositoryId[action.payload.repositoryId] = {
          status: "ready",
          result: action.payload.result,
          error: null,
        };
      })
      .addCase(runInstrumentation.rejected, (state, action) => {
        state.byRepositoryId[action.meta.arg] = {
          status: "error",
          result: null,
          error: action.error.message ?? "Failed to generate instrumentation",
        };
      });
  },
});

export default instrumentationSlice.reducer;
