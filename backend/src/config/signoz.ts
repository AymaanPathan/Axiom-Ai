import axios from "axios";

export const signozClient = axios.create({
  baseURL: process.env.SIGNOZ_URL || "http://localhost:8080",
  headers: {
    "SIGNOZ-API-KEY": process.env.SIGNOZ_API_KEY || "",
    "Content-Type": "application/json",
  },
});
