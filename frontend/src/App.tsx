import { BrowserRouter, Routes, Route } from "react-router-dom";
import Landing from "./pages/landing.page";
import Workspace from "./pages/Workspace.page";
import RepositoriesPage from "./pages/Repository.page";
import RepoDetail from "./pages/RepoDetail";
import ApiWorkspace from "./pages/ApiWorkSpace";
import RequireAuth from "./routes/RequireAuth";
import ObservabilityDashboard from "./pages/ObservabilityDashboard";
import EndpointsPage from "./pages/EndpointsPage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route
          path="/workspace"
          element={
            <RequireAuth>
              <Workspace />
            </RequireAuth>
          }
        >
          <Route index element={<RepositoriesPage />} />
          <Route path="repos/:repositoryId" element={<RepoDetail />} />
          <Route
            path="repos/:repositoryId/observability"
            element={<ObservabilityDashboard />}
          />
          <Route
            path="repos/:repositoryId/endpoints"
            element={<EndpointsPage />}
          />
          <Route
            path="repos/:repositoryId/endpoints/:routeIndex"
            element={<ApiWorkspace />}
          />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
