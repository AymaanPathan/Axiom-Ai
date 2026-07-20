import { configureStore } from "@reduxjs/toolkit";
import authReducer from "./slices/authSlice";
import reposReducer from "./slices/reposSlice";
import instrumentationReducer from "./slices/instrumentalSlice";
import observabilityReducer from "./slices/observabilitySlice"; 

export const store = configureStore({
  reducer: {
    auth: authReducer,
    repos: reposReducer,
    instrumentation: instrumentationReducer,
    observability: observabilityReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
