"use server";

import { createAdminClient, createSessionClient, createAuthActionClient } from "@/lib/supabase/server";
import { parseStringify } from "@/lib/utils";
import { redirect } from "next/navigation";

const handleError = (error: unknown, message: string) => {
  console.log(error, message);
  throw error;
};

export const createAccount = async ({
  fullName,
  email,
  password,
}: {
  fullName: string;
  email: string;
  password: string;
}) => {
  try {
    const authClient = await createAuthActionClient();
    const { data, error } = await authClient.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          name: fullName,
        },
      },
    });

    if (error) throw error;

    if (data.user?.id) {
      const adminClient = createAdminClient();
      const { data: existingUser } = await adminClient
        .from("users")
        .select("id")
        .eq("email", email)
        .single();

      if (existingUser) {
        await adminClient
          .from("users")
          .update({ account_id: data.user.id, full_name: fullName })
          .eq("email", email);
      } else {
        await adminClient.from("users").insert({
          account_id: data.user.id,
          email,
          full_name: fullName,
          avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=random&color=fff`,
        });
      }
    }

    return parseStringify({ success: true });
  } catch (error) {
    console.log(error, "Failed to create account");
    return parseStringify({
      success: false,
      error: "Unable to create account. Email may already be in use.",
    });
  }
};

export const getCurrentUser = async () => {
  try {
    const supabase = await createSessionClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) return null;

    const { data: userDataById, error } = await supabase
      .from("users")
      .select("*")
      .eq("account_id", user.id)
      .single();

    let userData = userDataById;

    // Fallback for legacy rows that still have email as account_id.
    if ((error || !userData) && user.email) {
      const { data: userDataByEmail } = await supabase
        .from("users")
        .select("*")
        .eq("email", user.email)
        .single();

      if (userDataByEmail) {
        await createAdminClient()
          .from("users")
          .update({ account_id: user.id })
          .eq("email", user.email);

        userData = { ...userDataByEmail, account_id: user.id };
      }
    }

    if (!userData) return null;

    // Normalize field names for component compatibility
    return parseStringify({
      ...userData,
      $id: userData.id,
      accountId: userData.account_id,
      fullName: userData.full_name,
    });
  } catch (error) {
    console.log(error);
    return null;
  }
};

export const signOutUser = async () => {
  try {
    const supabase = await createAuthActionClient();
    await supabase.auth.signOut();
  } catch (error) {
    handleError(error, "Failed to sign out user");
  } finally {
    redirect("/sign-in");
  }
};

export const signInUser = async ({
  email,
  password,
}: {
  email: string;
  password: string;
}) => {
  try {
    const authClient = await createAuthActionClient();
    const { data, error } = await authClient.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.user) {
      return parseStringify({
        success: false,
        error: "Invalid email or password.",
      });
    }

    return parseStringify({ success: true });
  } catch (error) {
    console.log(error, "Failed to sign in user");
    return parseStringify({ success: false, error: "Failed to sign in user." });
  }
};
