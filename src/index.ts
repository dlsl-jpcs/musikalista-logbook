import type { Server } from 'bun';
import { google } from 'googleapis';

const authJson = JSON.parse(Bun.env.AUTH_JSON!);


const SHEETS_ID = Bun.env.LOGBOOK_EXCEL_ID;

// api stuff
const SCOPES = [
    // sheets
    'https://www.googleapis.com/auth/spreadsheets',
]
const auth = new google.auth.GoogleAuth({
    credentials: authJson,
    scopes: SCOPES
});
const sheets = google.sheets({ version: 'v4', auth });


// main code

const logbookResponse = await sheets.spreadsheets.get({
    spreadsheetId: SHEETS_ID,
});



const logbook = logbookResponse.data!;


// check if the student has logged in the current sheet
// the student is considered logged if there is already a row with the student's id
// and there is no logout entry
// a student can log in multiple times in a day
async function hasStudentLogged(studentId: string) {
    // the workbook has a hidden sheet called 'LOOKUP_SHEET
    // that we can use to write formulas
    const lookupSheet = logbook.sheets?.find(sheet => sheet.properties?.title === 'LOOKUP_SHEET');
    if (!lookupSheet) {
        throw new Error('LOOKUP_SHEET not found');
    }

    const range = 'LOOKUP_SHEET!A1';

    // write a formula that retrives all the rows with the student's id
    const response = await sheets.spreadsheets.values.update({
        spreadsheetId: SHEETS_ID,
        range,
        valueInputOption: 'USER_ENTERED',
        includeValuesInResponse: true,
        responseValueRenderOption: 'UNFORMATTED_VALUE',
        requestBody: {
            values: [
                [`=IFERROR(COUNTIF('${getDateTitle()}'!A2:E, "${studentId}"), 0)`],
            ]
        }
    });

    // if the count is odd, the student has logged in 
    const values = response.data.updatedData?.values;
    const count = values ? parseInt(values[0][0]) : 0;

    console.log('Count', count);
    console.log("IN OR OUT", count % 2 === 1);

    return count % 2 === 1;
}

// logs in or out a student depending on the current state
// if the student has already logged in, log them out
// if the student hasn't logged in, log them in
async function logStudent(studentId: string) {
    await getOrCreateSheet();

    const hasLogged = await hasStudentLogged(studentId);

    const studentInfo = await getStudentInfo(studentId).catch(() => null);
    if (!studentInfo) {
        console.log('Student not found', studentId);
        return;
    }

    const sheet = getDateTitle();
    const range = sheet + '!A2:E';

    const date = new Date();
    // convert to GMT +8
    date.setHours(date.getHours() + 8);
    const time = date.toISOString().split('T')[1].split('.')[0];


    const type = hasLogged ? 'OUT' : 'IN';

    // insert the values [studentInfo.email_address, studentId, studentInfo.department, type, time]
    // to the table (adding a new row to the table if needed)

    const response = await sheets.spreadsheets.values.append({
        spreadsheetId: SHEETS_ID,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
            values: [
                [studentInfo.email_address, studentId, studentInfo.department, type, time]
            ]
        }
    });

    return !hasLogged;
}


function getDateTitle() {
    const date = new Date();
    date.setHours(date.getHours() + 8);
    return date.toISOString().split('T')[0];
}



// get the current sheet for the current date (GMT +8)
// if it doesn't exist, create it
async function getOrCreateSheet() {
    // get the current date (GMT +8)
    const dateString = getDateTitle();

    // check if the sheet exists
    const sheet = logbook.sheets?.find(sheet => sheet.properties?.title === dateString);
    if (sheet) {
        return sheet;
    }


    // the sheets has a 'TEMPLATE' sheet that we can copy
    // this sheet has a table that we will use to log the students
    const templateSheet = logbook.sheets?.find(sheet => sheet.properties?.title === 'TEMPLATE');
    if (!templateSheet) {
        throw new Error('TEMPLATE sheet not found');
    }

    // copy the template sheet, set the title to the current date
    const response = await sheets.spreadsheets.sheets.copyTo({
        spreadsheetId: SHEETS_ID,
        sheetId: templateSheet.properties?.sheetId!,
        requestBody: {
            destinationSpreadsheetId: SHEETS_ID,
        }
    });

    // rename the sheet
    const sheetId = response.data.sheetId!;
    const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEETS_ID,
        requestBody: {
            requests: [
                {
                    updateSheetProperties: {
                        properties: {
                            sheetId,
                            title: dateString,
                        },
                        fields: 'title',
                    }
                }
            ]
        }
    });

    return res.data.updatedSpreadsheet!;
}


async function getStudentInfo(studentId: string) {
    const apiUrl = 'https://student-info.tyronscott.me/api/student?id=' + studentId;
    const response = await fetch(apiUrl);
    return await response.json();
}









const server = Bun.serve({
    async fetch(request, server) {
        // return index.html
        const url = new URL(request.url);
        console.log(url.pathname);

        if (url.pathname === '/') {
            return new Response(Bun.file(import.meta.dir + "/index.html"));
        }

        if (url.pathname === '/log') {
            // get student id from body
            const body = await request.json();
            const studentId = body.studentId;

            if (!studentId) {
                return new Response('Student id not found', { status: 400 });
            }

            const studentInfo = await getStudentInfo(studentId).catch(() => null);
            if (!studentInfo) {
                return new Response('Student not found', { status: 404 });
            }

            try {
                const loggedIn = await logStudent(studentId);
                const message = loggedIn ? 'Logged in' : 'Logged out';
                return new Response(message);
            } catch (e) {
                return new Response('Error', { status: 500 });
            }
        }

        return new Response('Not found', { status: 404 });
    },
});
console.log('Server running on port', server.port);