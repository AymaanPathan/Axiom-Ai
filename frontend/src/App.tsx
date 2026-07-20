import { BrowserRouter, Routes, Route } from "react-router-dom";
import Landing from "./pages/landing.page";
import Workspace from "./pages/Workspace.page";
import RepositoriesPage from "./pages/Repository.page";
import RepoDetail from "./pages/RepoDetail";
import RequireAuth from "./routes/RequireAuth";

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
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
