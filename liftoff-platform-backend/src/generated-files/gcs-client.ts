// GCS client for generated-files module
// Uses Application Default Credentials (Cloud Run) or GOOGLE_APPLICATION_CREDENTIALS (local dev).

import { Storage } from '@google-cloud/storage';

export const storage = new Storage();

/**
 * The bucket every generated artifact lives in.
 *
 * REQUIRED, with no default. A fallback to the dev bucket's literal name would
 * be wrong in exactly one environment and wrong in the worst way: an unset
 * variable in production would not fail, it would silently read and write
 * DEV's storage. A customer's generated document would land in the dev bucket,
 * and a dev object id would resolve for a production caller.
 *
 * Throwing here instead means a misconfigured deployment is a loud 500 on the
 * first artifact rather than a quiet cross-environment leak. Terraform sets it
 * from the bucket resource itself (generated-files-bucket.tf), so the name
 * cannot drift from the thing it names.
 */
export const generatedFilesBucket = (): ReturnType<Storage['bucket']> => {
  const name = process.env.GENERATED_FILES_BUCKET;
  if (!name) {
    throw new Error(
      'GENERATED_FILES_BUCKET is not set. It is required and has no default: '
      + 'falling back to a fixed name would point one environment at another\'s storage.',
    );
  }
  return storage.bucket(name);
};
