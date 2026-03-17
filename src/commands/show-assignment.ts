import { CanvasClient } from "../canvas/client.js";
import { loadConfig } from "../config/env.js";
import { resolveAssignment } from "../domain/resolve-assignment.js";
import { renderAssignmentDetail } from "../format/renderAssignmentDetail.js";
import { handleError } from "../errors.js";

interface ShowAssignmentOptions {
  course?: string;
  id?: string;
  json?: boolean;
}

export async function showAssignmentCommand(
  name: string,
  options: ShowAssignmentOptions
): Promise<void> {
  const config = loadConfig();
  const client = new CanvasClient(config);

  let rawCourses;
  try {
    rawCourses = await client.getCourses();
  } catch (err) {
    handleError(err);
    return;
  }

  try {
    const { detail } = await resolveAssignment(name, options, client, rawCourses);

    if (options.json) {
      console.log(JSON.stringify(detail, null, 2));
    } else {
      console.log(renderAssignmentDetail(detail));
    }
  } catch (err) {
    handleError(err);
  }
}
