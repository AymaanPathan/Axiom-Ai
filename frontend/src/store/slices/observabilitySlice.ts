// src/store/slices/observabilitySlice.ts
import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import axios from "axios";

export interface RouteStat {
  route: string;
  requests: number;
  p50: number;
  p99: number;
  errors: number;
}
type Status = "starting" | "waiting" | "live" | "error";
interface ObsState {
  status: Status;
  routes: RouteStat[];
  error?: string;
}

const initialState: Record<string, ObsState> = {};

export const checkObservabilityStatus = createAsyncThunk(
  "observability/checkStatus",
  async ({
    repositoryId,
    serviceName,
  }: {
    repositoryId: string;
    serviceName: string;
  }) => {
    const { data } = await axios.get(`/observability/${repositoryId}/status`, {
      params: { serviceName },
      withCredentials: true,
    });
    return { repositoryId, status: data.status as "waiting" | "live" };
  },
);

export const fetchRouteMetrics = createAsyncThunk(
  "observability/fetchMetrics",
  async ({
    repositoryId,
    serviceName,
  }: {
    repositoryId: string;
    serviceName: string;
  }) => {
    const { data } = await axios.get(`/observability/${repositoryId}/metrics`, {
      params: { serviceName },
      withCredentials: true,
    });
    return { repositoryId, routes: data.routes as RouteStat[] };
  },
);

const slice = createSlice({
  name: "observability",
  initialState,
  reducers: {
    startObservability(state, action: { payload: { repositoryId: string } }) {
      state[action.payload.repositoryId] = { status: "starting", routes: [] };
    },
  },
  extraReducers: (b) => {
    b.addCase(checkObservabilityStatus.fulfilled, (s, a) => {
      s[a.payload.repositoryId] ??= { status: "starting", routes: [] };
      s[a.payload.repositoryId].status = a.payload.status;
    });
    b.addCase(checkObservabilityStatus.rejected, (s, a) => {
      const id = a.meta.arg.repositoryId;
      s[id] ??= { status: "starting", routes: [] };
      s[id].status = "error";
      s[id].error = a.error.message;
    });
    b.addCase(fetchRouteMetrics.fulfilled, (s, a) => {
      s[a.payload.repositoryId] ??= { status: "live", routes: [] };
      s[a.payload.repositoryId].routes = a.payload.routes;
    });
  },
});

export const { startObservability } = slice.actions;
export default slice.reducer;
