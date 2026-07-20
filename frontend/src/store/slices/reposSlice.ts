import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import {
  listRepos,
  connectRepo,
  getRepoDetail,
  type GithubRepo,
  type ConnectedRepository,
} from "../../api/repos";

interface ReposState {
  items: GithubRepo[];
  status: "idle" | "loading" | "loaded" | "error";
  error: string | null;
  connectingFullName: string | null;
  connectError: string | null;
  // Cache of repos the user has connected this session, keyed by repositoryId.
  // Populated by connectRepository and by fetchRepoDetail (for direct
  // navigation / refresh on a repo detail page).
  byId: Record<string, ConnectedRepository>;
}

const initialState: ReposState = {
  items: [],
  status: "idle",
  error: null,
  connectingFullName: null,
  connectError: null,
  byId: {},
};

export const fetchRepos = createAsyncThunk("repos/fetchRepos", async () => {
  return await listRepos();
});

export const connectRepository = createAsyncThunk(
  "repos/connectRepository",
  async ({ owner, repo }: { owner: string; repo: string }) => {
    return await connectRepo(owner, repo);
  },
);

export const fetchRepoDetail = createAsyncThunk(
  "repos/fetchRepoDetail",
  async (repositoryId: string) => {
    return await getRepoDetail(repositoryId);
  },
);

const reposSlice = createSlice({
  name: "repos",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchRepos.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchRepos.fulfilled, (state, action) => {
        state.status = "loaded";
        state.items = action.payload;
      })
      .addCase(fetchRepos.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Failed to load repositories";
      })
      .addCase(connectRepository.pending, (state, action) => {
        state.connectingFullName = `${action.meta.arg.owner}/${action.meta.arg.repo}`;
        state.connectError = null;
      })
      .addCase(connectRepository.fulfilled, (state, action) => {
        state.connectingFullName = null;
        state.byId[action.payload.repositoryId] = action.payload;
      })
      .addCase(connectRepository.rejected, (state, action) => {
        state.connectingFullName = null;
        state.connectError =
          action.error.message ?? "Failed to connect repository";
      })
      .addCase(fetchRepoDetail.fulfilled, (state, action) => {
        state.byId[action.payload.repositoryId] = action.payload;
      });
  },
});

export default reposSlice.reducer;
