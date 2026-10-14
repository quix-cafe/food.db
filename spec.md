# Product & Technical Specification: Kitchen Cost & Recipe Manager

## 1. Overview and Reference
This document serves as the master specification for the Kitchen Cost & Recipe Manager application. It outlines the phased feature rollout, system architecture, database schema, and frontend UI design. 

**Reference File:** All features and initial requirements documented herein are sourced from the primary feature tracking file: `Feature Database 3f86305003eb80da9122e348fa7f16bd_all_2.csv`.

---

## 2. Technology Stack & Infrastructure
* **Backend:** Node.js (Express or Fastify framework)
* **Database:** PostgreSQL (Relational structure for strict schema enforcement)
* **Frontend:** React or Vue.js Single Page Application (SPA)
* **Financial Math:** `decimal.js` or `currency.js` (Required globally to prevent floating-point errors)
* **Local OCR Pipeline:** 
  * `sharp` (Node.js) for image pre-processing (grayscale, contrast, auto-rotate).
  * `Ollama` running locally on the host machine using a Vision-Language Model (e.g., Qwen2.5-VL or Florence-2) for secure, localized receipt parsing.
* **Deployment:** Dockerized multi-service architecture (`docker-compose.yml` linking Node app, PostgreSQL database, and host Ollama port `11434`).

---

## 3. Database Schema Models
The system utilizes a relational model to maintain historical pricing without breaking existing recipes.

* **`Ingredient` (Master):** `Asset_ID` (UUID), `Name`, `Category`, `Default_Yield_Percent`, `Created_At`.
* **`Ingredient_Purchase` (History):** `Purchase_ID`, `Ingredient_ID` (FK), `Date`, `Vendor`, `Quantity`, `Weight`, `Unit_of_Measurement`, `Unit_Cost` (Decimal), `Total_Cost` (Decimal).
* **`Recipe`:** `Recipe_ID`, `Name`, `Base_Servings` (Locked), `Total_Yield` (Locked), `Target_Margin`.
* **`Recipe_Ingredient`:** `Recipe_ID` (FK), `Ingredient_ID` (FK), `Use_Percent` (Decimal), `Base_Quantity`.
* **`Event`:** `Event_ID`, `Date`, `Name`.
* **`Event_Recipe`:** `Event_ID` (FK), `Recipe_ID` (FK), `Expected_Servings` (Integer).

---

## 4. Core Features & User Stories

### 4.1 Ingredients Database (Master Data)
* **Centralized Manual Entry (MVP):** Add ingredients with specific fields (Name, Date, Vendor, Quantity, Weight, Unit, Unit Cost, Total Cost) generating a unique Asset ID.
* **Duplicate/Recurring Purchases (Phase 1):** Allow multiple purchases of the same ingredient over time to track pricing without throwing duplicate errors. New purchases do not overwrite historical `Unit_Cost`.
* **Price History & Vendor Tracking (Phase 2):** Relational history linked by Asset ID, visually represented by charts to flag vendor price hikes.
* **"Biggest Raw" Yield & Use % Breakdown (MVP):** Calculate true cost based on kitchen usage/trim loss. (e.g., Using 5% of a bulk item calculates only 5% of the unit cost).

### 4.2 Local OCR Receipt Scanner
* **Image Pre-processing:** System converts thermal receipt images to high-contrast grayscale before processing.
* **End-to-End Local VLM:** Sends image to local Ollama instance for structured JSON extraction (Item, Qty, Cost).
* **"Review & Confirm" Protocol:** OCR output is never auto-committed. Extracted data populates an editable grid where users must manually verify and confirm each row.

### 4.3 Dynamic Recipe Builder & Yield Scaler
* **Single Recipe Costing (MVP):** Dynamically pulls the *most recent* Unit Cost from the database. Multiplies Unit Cost × Use % × Quantity for all line items.
* **Real-Time Yield Scaling (MVP):** Adjusting "Expected no. of servings" automatically recalculates Purchase Quantity and Scaled Cost without altering the base recipe database entry.
* **Volume Profitability & Target Margins (MVP):** Instantly displays Scaled Cost, Total Profit, and recommended Sales Price based on a default 70% margin.

### 4.4 Event Day Planner (Phase 2)
* **Cost Projections:** Pull scheduled recipes for a specific calendar date to see aggregated total cost, projected revenue, and overall profit margin.
* **Consolidated Shopping & Prep List:** Combines requirements from all event recipes into one master list. Uses precise Use % logic to aggregate fractional usage of identical ingredients across multiple recipes into a single required unit amount.

---

## 5. API Endpoints Specification

* **`POST /api/ingredients/upload-receipt`:** Accepts multipart/form-data image, processes via `sharp`, calls Ollama API, returns parsed JSON array for frontend review.
* **`POST /api/ingredients/purchase`:** Commits reviewed items to `Ingredient_Purchase` (generating historical price points).
* **`GET /api/ingredients`:** Retrieves master ingredient list joined with the most recent `Unit_Cost`. Supports debounced search queries and category filters.
* **`GET /api/ingredients/:id/history`:** Retrieves time-series data of all purchases for a specific ingredient.
* **`POST /api/recipes/calculate`:** Accepts an array of ingredients + `Expected_Servings`. Returns real-time scaled costs, margins, and recommended prices (stateless).
* **`GET /api/events/:id/summary`:** Returns aggregated event financials (Cost, Revenue, Profit) and the consolidated master shopping list.

---

## 6. Frontend Architecture & UI Layout

### Global Shell
* **Persistent Navigation:** Sticky left sidebar for core routes (Database, Recipes, Events).
* **Global Header:** Features a debounced universal search bar and a persistent "Quick Add / Snap Receipt" button accessible from anywhere.

### View 1: Master Ingredients Database
* **Central Grid:** Spreadsheet-style table with sortable column headers and quick-filter category chips.
* **OCR Split-Screen:** Left pane shows the user's uploaded receipt (zoomable); Right pane houses the "Review & Confirm" editable data grid for OCR results.
* **Detail Drawer:** Slide-out right panel showing an ingredient's price history chart, vendor list, and editable yield/trim loss fields.

### View 2: Dynamic Recipe Builder
* **Left Pane (Input Canvas):** Drag-and-drop ingredient list using a searchable combobox tied to the master database. Contains inputs for Base Quantity and Use %.
* **Right Pane (Sticky Financials):** Fixed panel showing Total Cost, Cost Per Serving, and Net Profit. Features the "Expected Servings" input for instant DOM reactivity/scaling without database saves.

### View 3: Single Page Recipe Gallery
* **Visual Index:** Card-based UI displaying Recipe Name, Cost Per Serving, Target Margin, and a timestamp for the latest price sync.
* **Context Actions:** Three-dot menu for "Edit", "Duplicate", or "Add to Event".

### View 4: Event Day Planner
* **Configuration:** Top-level inputs for Event Name, Date, and global guest count.
* **Recipe Grid:** Multi-select interface to attach existing recipes, exposing local override inputs for servings specific to that event.
* **Output Tabs:**
  * *Tab 1 (Financials):* High-level cards for Projected Cost, Revenue, and Total Profit.
  * *Tab 2 (Shopping List):* The consolidated, mathematically aggregated prep list.

---

## 7. Core Business Logic & Mathematics

* **Fractional Cost:** `Line Item Cost = Most Recent Unit_Cost * (Use_Percent / 100) * Quantity`
* **Scaling Factor:** `Scale = Expected_Servings / Base_Servings`
* **Target Sales Price:** `Recommended Price = Cost_Per_Serving / (1 - (Target_Margin_Percentage / 100))`
* **Master Event Aggregation:** 
  $$\sum_{i=1}^{n} (Recipe\_Ingredient\_Qty_i \times \frac{Expected\_Servings_i}{Base\_Servings_i})$$ grouped by `Ingredient_ID` and `Unit_of_Measurement`.