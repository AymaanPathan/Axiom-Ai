import { configureStore } from "@reduxjs/toolkit";
import authReducer from "./slices/authSlice";
import reposReducer from "./slices/reposSlice";
import observabilityReducer from "./slices/observabilitySlice"; 

export const store = configureStore({
  reducer: {
    auth: authReducer,
    repos: reposReducer,
    observability: observabilityReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
