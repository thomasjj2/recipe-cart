# Recipe Cart Deployment Checklist

Follow this step-by-step checklist to deploy your Recipe Cart application using GitHub, Firebase, and Netlify.

---

## 1. Create a New Git Repository
- [ ] Go to [GitHub](https://github.com) (or GitLab) and create a new **empty repository** named `recipe-cart`.
- [ ] **Crucial:** Do **not** check the boxes to add a README, `.gitignore`, or license. You already have these files locally.
- [ ] Copy the repository's **HTTPS URL** (e.g., `https://github.com/your-username/recipe-cart.git`) for the next step.

## 2. Push Your Local Project
- [ ] Open your terminal and change directory into your local project folder:
  ```bash
  cd recipe-cart
  ```
- [ ] Initialize Git locally:
  ```bash
  git init
  ```
- [ ] Stage all project files:
  ```bash
  git add .
  ```
- [ ] Commit the files:
  ```bash
  git commit -m "initial commit"
  ```
- [ ] Link your local repository to your remote GitHub repository:
  ```bash
  git remote add origin <PASTE_YOUR_COPIED_URL_HERE>
  ```
- [ ] Rename the default branch to `main`:
  ```bash
  git branch -M main
  ```
- [ ] Push your code to GitHub:
  ```bash
  git push -u origin main
  ```
- [ ] Refresh your GitHub repository page to verify all your files are visible.

## 3. Create a Firebase Project & Enable Sign-In
- [ ] Navigate to the [Firebase Console](https://console.firebase.google.com).
- [ ] Click **Add project**, name it `recipe-cart`, and click continue.
- [ ] Disable **Google Analytics** (it is not needed for this project) and click **Create project**.
- [ ] Once ready, navigate to the left sidebar and select **Build > Authentication**, then click **Get started**.
- [ ] Under the **Sign-in method** tab, select **Google** as a provider, switch the toggle to **Enable**, and save.

## 4. Create Firestore Database & Apply Security Rules
- [ ] In the Firebase Console sidebar, navigate to **Build > Firestore Database** and click **Create database**.
- [ ] Select **Production mode** and choose a cloud region geographically close to you.
- [ ] Once the database initializes, click on the **Rules** tab.
- [ ] Delete the default rules and paste the exact contents from your local project's `firestore.rules` file (this ensures clients cannot access data directly; only Netlify functions can).
- [ ] Click **Publish**.

## 5. Get Firebase Configurations & Service Account Key
- [ ] Click the **Project settings** (gear icon) next to Project Overview in the top left.
- [ ] Under the **General** tab, scroll down to *Your apps* and click the Web icon (`</>`).
- [ ] Register your app with any nickname (e.g., `recipe-cart-web`) and **skip** Firebase Hosting.
- [ ] Copy the `firebaseConfig` object from the code snippet provided.
- [ ] Open your local `index.html` file and paste this object into the corresponding `firebaseConfig` variable near the top of the script tag.
- [ ] Return to Firebase Project Settings and go to the **Service accounts** tab.
- [ ] Click the **Generate new private key** button. This will download a `.json` file to your computer.
- [ ] Open this JSON file in a text editor and copy its entire raw content. You will need it for Step 7.

## 6. Create the Netlify Site
- [ ] Log into the [Netlify Dashboard](https://app.netlify.com).
- [ ] Click **Add new site > Import an existing project**.
- [ ] Connect your **GitHub** account and select your `recipe-cart` repository.
- [ ] In the build configuration settings:
  - Leave the **Build command** completely blank.
  - Set the **Publish directory** to a single period (`.`).
- [ ] Click **Deploy site**. *Note: The initial build might fail or only partially work because environment variables aren't set yet. This is expected.*

## 7. Configure Netlify Environment Variables
- [ ] Inside your Netlify site dashboard, navigate to **Site configuration > Environment variables** and click **Add a variable**.
- [ ] Add the following six required environment variables:
  
  | Variable Name | Description / Value |
  | :--- | :--- |
  | `ANTHROPIC_API_KEY` | Your live Claude API key from Anthropic. |
  | `KROGER_CLIENT_ID` | Client ID from your developer account at [Kroger Developer Portal](https://developer.kroger.com). |
  | `KROGER_CLIENT_SECRET` | Client Secret from your Kroger developer account. |
  | `KROGER_REDIRECT_URI` | Your absolute Netlify function callback path (See Step 8 for format). |
  | `APP_URL` | Your primary Netlify site URL (e.g., `https://recipe-cart-xyz.netlify.app`). |
  | `FIREBASE_SERVICE_ACCOUNT_JSON` | The **entire raw JSON string** you copied from the service account key in Step 5. |

- [ ] After saving all variables, navigate to the **Deploys** tab.
- [ ] Click the **Trigger deploy** dropdown and select **Deploy site** so Netlify rebuilds the application with the new variables active.

## 8. Wire Up Kroger Redirect & Authorized Domains
- [ ] Copy your live Netlify production URL (e.g., `https://recipe-cart-xyz.netlify.app`).
- [ ] Log into the [Kroger Developer Portal](https://developer.kroger.com), open your registered application, and update the **Redirect URI** to:
  `https://your-site-name.netlify.app/.netlify/functions/kroger-auth-callback`  
  *(Ensure this string perfectly matches the value you saved for `KROGER_REDIRECT_URI` in Netlify).*
- [ ] Head back to your **Firebase Console > Authentication > Settings**.
- [ ] Under **Authorized domains**, click **Add domain** and enter your Netlify domain name (e.g., `recipe-cart-xyz.netlify.app`) so Firebase permits Google sign-ins from your live app.
- [ ] Open your live Netlify site, authenticate with Google, paste a recipe, and test sending items directly to your Kroger grocery cart!