import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import {
  fetchCurrentUser,
  logout as logoutRequest,
  type GithubUser,
} from "../../api/auth";

type AuthStatus =
  | "idle"
  | "loading"
  | "authenticated"
  | "unauthenticated"
  | "error";

interface AuthState {
  status: AuthStatus;
  user: GithubUser | null;
  error: string | null;
}

const initialState: AuthState = {
  status: "idle",
  user: null,
  error: null,
};

/** Checks the httpOnly session cookie against the backend on app load. */
export const checkSession = createAsyncThunk("auth/checkSession", async () => {
  return await fetchCurrentUser();
});

export const signOut = createAsyncThunk("auth/signOut", async () => {
  await logoutRequest();
});

const authSlice = createSlice({
  name: "auth",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(checkSession.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(checkSession.fulfilled, (state, action) => {
        if (action.payload.authenticated && action.payload.user) {
          state.status = "authenticated";
          state.user = action.payload.user;
        } else {
          state.status = "unauthenticated";
          state.user = null;
        }
      })
      .addCase(checkSession.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Failed to check session";
      })
      .addCase(signOut.fulfilled, (state) => {
        state.status = "unauthenticated";
        state.user = null;
      });
  },
});

export default authSlice.reducer;
