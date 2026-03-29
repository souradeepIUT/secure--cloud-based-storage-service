"use server";

import { createAdminClient } from "@/lib/supabase/server";
import { supabaseConfig } from "@/lib/supabase/config";
import { constructFileUrl, getFileType, parseStringify } from "@/lib/utils";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/actions/user.actions";

const handleError = (error: unknown, message: string) => {
  console.log(error, message);
  throw error;
};

export const uploadFile = async ({
  file,
  ownerId,
  accountId,
  path,
}: UploadFileProps) => {
  const supabase = createAdminClient();

  try {
    const fileName = `${Date.now()}_${file.name}`;
    const filePath = `${accountId}/${fileName}`;

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const { error: storageError } = await supabase.storage
      .from(supabaseConfig.bucketName)
      .upload(filePath, buffer, {
        contentType: file.type,
        upsert: false,
      });

    if (storageError) handleError(storageError, "Failed to upload file to storage");

    const { type, extension } = getFileType(file.name);
    const publicUrl = constructFileUrl(filePath);

    const { data: fileRecord, error: dbError } = await supabase
      .from("files")
      .insert({
        type,
        name: file.name,
        url: publicUrl,
        extension,
        size: file.size,
        owner: ownerId,
        account_id: accountId,
        users: [],
        bucket_file_id: filePath,
      })
      .select()
      .single();

    if (dbError) {
      // Rollback storage upload
      await supabase.storage.from(supabaseConfig.bucketName).remove([filePath]);
      handleError(dbError, "Failed to create file document");
    }

    revalidatePath(path);
    return parseStringify(normalizeFile(fileRecord));
  } catch (error) {
    handleError(error, "Failed to upload file");
  }
};

// Normalize DB row to match component expectations ($id, $createdAt etc.)
const normalizeFile = (file: Record<string, unknown>) => ({
  ...file,
  $id: file.id,
  $createdAt: file.created_at,
  $updatedAt: file.updated_at,
  bucketFileId: file.bucket_file_id,
  accountId: file.account_id,
});

export const getFiles = async ({
  types = [],
  searchText = "",
  sort = "created_at-desc",
  limit,
}: GetFilesProps) => {
  const supabase = createAdminClient();

  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return parseStringify({ documents: [], total: 0 });
    }

    let query = supabase
      .from("files")
      .select("*")
      .or(`owner.eq.${currentUser.$id},users.cs.{${currentUser.email}}`);

    if (types.length > 0) query = query.in("type", types);
    if (searchText) query = query.ilike("name", `%${searchText}%`);
    if (limit) query = query.limit(limit);

    // Parse sort param like "created_at-desc" or "$createdAt-desc"
    const sortField = sort.replace("$createdAt", "created_at").replace("$updatedAt", "updated_at").split("-")[0];
    const sortOrder = sort.split("-")[1] === "asc";
    query = query.order(sortField || "created_at", { ascending: sortOrder });

    const { data, error } = await query;
    if (error) handleError(error, "Failed to get files");

    const documents = (data || []).map(normalizeFile);
    return parseStringify({ documents, total: documents.length });
  } catch (error) {
    console.log(error, "Failed to get files");
    return parseStringify({ documents: [], total: 0 });
  }
};

export const renameFile = async ({
  fileId,
  name,
  extension,
  path,
}: RenameFileProps) => {
  const supabase = createAdminClient();

  try {
    const newName = `${name}.${extension}`;
    const { data, error } = await supabase
      .from("files")
      .update({ name: newName, updated_at: new Date().toISOString() })
      .eq("id", fileId)
      .select()
      .single();

    if (error) handleError(error, "Failed to rename file");

    revalidatePath(path);
    return parseStringify(normalizeFile(data));
  } catch (error) {
    handleError(error, "Failed to rename file");
  }
};

export const updateFileUsers = async ({
  fileId,
  emails,
  path,
}: UpdateFileUsersProps) => {
  const supabase = createAdminClient();

  try {
    const { data, error } = await supabase
      .from("files")
      .update({ users: emails, updated_at: new Date().toISOString() })
      .eq("id", fileId)
      .select()
      .single();

    if (error) handleError(error, "Failed to update file users");

    revalidatePath(path);
    return parseStringify(normalizeFile(data));
  } catch (error) {
    handleError(error, "Failed to update file users");
  }
};

export const deleteFile = async ({
  fileId,
  bucketFileId,
  path,
}: DeleteFileProps) => {
  const supabase = createAdminClient();

  try {
    const { error: dbError } = await supabase
      .from("files")
      .delete()
      .eq("id", fileId);

    if (dbError) handleError(dbError, "Failed to delete file record");

    // Remove from storage
    await supabase.storage
      .from(supabaseConfig.bucketName)
      .remove([bucketFileId]);

    revalidatePath(path);
    return parseStringify({ status: "success" });
  } catch (error) {
    handleError(error, "Failed to delete file");
  }
};

export async function getTotalSpaceUsed() {
  const emptyTotalSpace = {
    image: { size: 0, latestDate: "" },
    document: { size: 0, latestDate: "" },
    video: { size: 0, latestDate: "" },
    audio: { size: 0, latestDate: "" },
    other: { size: 0, latestDate: "" },
    used: 0,
    all: 2 * 1024 * 1024 * 1024, // 2GB
  };

  try {
    const supabase = createAdminClient();
    const currentUser = await getCurrentUser();
    if (!currentUser) return parseStringify(emptyTotalSpace);

    const { data: files, error } = await supabase
      .from("files")
      .select("*")
      .eq("owner", currentUser.$id);

    if (error) handleError(error, "Failed to fetch files for storage usage");

    const totalSpace = { ...emptyTotalSpace };

    (files || []).forEach((file) => {
      const fileType = file.type as FileType;
      totalSpace[fileType].size += file.size;
      totalSpace.used += file.size;

      if (
        !totalSpace[fileType].latestDate ||
        new Date(file.updated_at) > new Date(totalSpace[fileType].latestDate)
      ) {
        totalSpace[fileType].latestDate = file.updated_at;
      }
    });

    return parseStringify(totalSpace);
  } catch (error) {
    console.log(error, "Error calculating total space used");
    return parseStringify(emptyTotalSpace);
  }
}
