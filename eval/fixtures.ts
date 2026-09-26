// Synthetic UK care documents with ground truth, for measuring the anonymiser.
//
// Every person, place and number here is invented. `remove` lists each string
// that must not survive in the output (as written in the document), with its
// type; `keep` lists care content that must survive, to catch over-removal.
//
// Paragraph markup (Word fixtures): "|" splits a run, so a name can be spread
// over several <w:t> elements the way Word often stores it; "~~text~~" is a
// tracked deletion. Both markers are stripped for PDFs and images.

import type { EntityType } from '../src/shared/types.js';

export type Block =
  { h: string } | { p: string; comment?: { author: string; text: string } } | { table: string[][] };

export interface Fixture {
  id: string;
  format: 'pdf' | 'scan' | 'photo' | 'docx';
  fileName: string;
  author?: string;
  header?: string;
  footer?: string;
  blocks: Block[];
  remove: [string, EntityType][];
  keep: string[];
}

export const FIXTURES: Fixture[] = [
  {
    id: 'care-plan',
    format: 'pdf',
    fileName: 'Care plan - Margaret Jones.pdf',
    author: 'Rhian Morgan',
    blocks: [
      { h: 'Person-centred care plan' },
      {
        table: [
          ['Name', 'Margaret Jones'],
          ['Preferred name', 'Maggie'],
          ['Date of birth', '14/03/1941'],
          ['NHS number', '573 856 3913'],
          ['Address', '12 Heol y Nant, Barry, CF62 7AB'],
          ['Telephone', '01446 734 219'],
          ['Next of kin', 'Susan Price (daughter), 07700 900 123'],
          ['GP', 'Dr Anwar, Castle View Surgery'],
        ],
      },
      { h: 'About me' },
      {
        p: 'Maggie was born in Pontypridd and worked for thirty years as a school cook at Ysgol Sant Baruc. She was married to Tom, who died in 2019, and she still misses him every day. Her daughter Susan visits on Tuesdays and Saturdays; her son Gareth lives in Bristol and phones on Sunday evenings.',
      },
      {
        p: 'Maggie loves her cat, Pickles, and gets anxious if Pickles is not fed before 8am. She enjoys the Barry Male Voice Choir concerts at St Nicholas Church and likes to talk about her time at Ysgol Sant Baruc.',
      },
      { h: 'Health' },
      {
        p: 'Type 2 diabetes managed with Metformin 500mg twice daily. Mild vascular dementia diagnosed in 2023. Uses a walking frame indoors. At risk of falls, especially at night.',
      },
      { h: 'Support needed' },
      {
        p: 'Morning call (45 minutes): support with personal care, prompt medication, prepare breakfast. Evening call (30 minutes): prepare a light meal, prompt medication, help to bed. Mrs Jones prefers female carers and likes her tea with one sugar.',
      },
      {
        p: 'If Maggie seems unwell, contact Susan first, then Castle View Surgery on 01446 700 350. Key safe code is held by the office.',
      },
      {
        p: 'Plan agreed with Margaret and Susan Price by Rhian Morgan, care coordinator, on 2 September 2026.',
      },
    ],
    remove: [
      ['Margaret Jones', 'PERSON'],
      ['Maggie', 'PERSON'],
      ['Mrs Jones', 'PERSON'],
      ['Margaret', 'PERSON'],
      ['14/03/1941', 'DATE_OF_BIRTH'],
      ['573 856 3913', 'ID'],
      ['12 Heol y Nant', 'ADDRESS'],
      ['CF62 7AB', 'ADDRESS'],
      ['01446 734 219', 'PHONE'],
      ['Susan Price', 'PERSON'],
      ['Susan', 'PERSON'],
      ['07700 900 123', 'PHONE'],
      ['Dr Anwar', 'PERSON'],
      ['Castle View Surgery', 'ORGANISATION'],
      ['01446 700 350', 'PHONE'],
      ['Tom', 'PERSON'],
      ['Gareth', 'PERSON'],
      ['Ysgol Sant Baruc', 'ORGANISATION'],
      ['Pickles', 'OTHER'],
      ['Rhian Morgan', 'PERSON'],
      ['Pontypridd', 'PLACE'],
    ],
    keep: [
      'Type 2 diabetes',
      'Metformin 500mg',
      'walking frame',
      'Morning call',
      'prefers female carers',
      'daughter',
      'Tuesdays',
    ],
  },
  {
    id: 'referral-letter',
    format: 'docx',
    fileName: 'Referral D Pritchard.docx',
    author: 'Owain Lloyd',
    header: 'Vale Community Care Team · Referral for domiciliary care',
    footer: 'Ref: VCC/2026/0417 · Owain Lloyd, Social Worker · owain.lloyd@example-council.gov.uk',
    blocks: [
      { h: 'Referral for home care' },
      { p: 'Dear Care Coordinator,' },
      {
        p: 'I am referring Mr Dafydd Pri|tchard (DOB 02/11/1938, NHS 480 986 5347) of 7 Min y Coed, Dinas Powys, CF64 4RT for a package of home care following his discharge from Llandough Hospital, Ward W4.',
      },
      {
        p: 'Dafydd lives alone since his wife Eirlys moved into Hafan Deg Care Home in May. He is a retired postman and is well known in the village; he still walks to The Star Inn most afternoons when he is able.',
        comment: {
          author: 'Owain Lloyd',
          text: 'Check with Eirlys’s key worker, Bethan, about visiting times.',
        },
      },
      {
        p: 'His nephew, Rhys Evans, is his main contact (0292 051 7788, rhys.evans@example.com). Mr Pritchard can be reluctant to accept help and may say he is ~~fine~~ managing.',
      },
      {
        table: [
          ['Need', 'Detail'],
          ['Personal care', 'Help with washing and dressing each morning'],
          ['Medication', 'Blister pack from Dinas Powys Pharmacy, prompt only'],
          ['Meals', 'Heat a ready meal at lunchtime'],
        ],
      },
      { p: 'Please contact me with any questions.' },
      { p: 'Owain Lloyd' },
    ],
    remove: [
      ['Dafydd Pritchard', 'PERSON'],
      ['Mr Pritchard', 'PERSON'],
      ['Dafydd', 'PERSON'],
      ['02/11/1938', 'DATE_OF_BIRTH'],
      ['480 986 5347', 'ID'],
      ['7 Min y Coed', 'ADDRESS'],
      ['Dinas Powys', 'PLACE'],
      ['CF64 4RT', 'ADDRESS'],
      ['Eirlys', 'PERSON'],
      ['Hafan Deg Care Home', 'ORGANISATION'],
      ['The Star Inn', 'ORGANISATION'],
      ['Rhys Evans', 'PERSON'],
      ['0292 051 7788', 'PHONE'],
      ['rhys.evans@example.com', 'EMAIL'],
      ['Owain Lloyd', 'PERSON'],
      ['owain.lloyd@example-council.gov.uk', 'EMAIL'],
      ['Bethan', 'PERSON'],
      ['VCC/2026/0417', 'ID'],
      ['Llandough Hospital', 'ORGANISATION'],
    ],
    keep: [
      'package of home care',
      'retired postman',
      'Personal care',
      'Blister pack',
      'ready meal',
      'nephew',
    ],
  },
  {
    id: 'incident-report',
    format: 'pdf',
    fileName: 'incident report 0923.pdf',
    blocks: [
      { h: 'Incident report' },
      {
        table: [
          ['Date and time', '23 September 2026, 07:40'],
          ['Location', 'Room 14, Bryn Awel Residential Home, Penarth'],
          ['Person involved', 'Joan Whitfield (Room 14)'],
          ['Reported by', 'Kelly Hughes, senior carer'],
          ['Witness', 'Priya Nair, night carer'],
        ],
      },
      { h: 'What happened' },
      {
        p: 'During the morning check Kelly found Joan on the floor beside her bed. Joan said she had tried to get to the bathroom without her frame. She had a small graze on her left elbow and complained of pain in her right hip.',
      },
      {
        p: 'Priya confirmed that at the 05:00 check Mrs Whitfield was asleep and her call bell was in reach. The sensor mat had been moved under the chair, and it is not known who moved it.',
      },
      { h: 'Actions taken' },
      {
        p: '111 called at 07:52. Paramedics attended and took Joan to University Hospital of Wales for an X-ray. Her son, Mark Whitfield, was informed by phone at 08:15. Manager on duty: Andrew Collins.',
      },
    ],
    remove: [
      ['Room 14', 'ID'],
      ['Bryn Awel Residential Home', 'ORGANISATION'],
      ['Penarth', 'PLACE'],
      ['Joan Whitfield', 'PERSON'],
      ['Joan', 'PERSON'],
      ['Mrs Whitfield', 'PERSON'],
      ['Kelly Hughes', 'PERSON'],
      ['Kelly', 'PERSON'],
      ['Priya Nair', 'PERSON'],
      ['Priya', 'PERSON'],
      ['Mark Whitfield', 'PERSON'],
      ['Andrew Collins', 'PERSON'],
    ],
    keep: ['graze on her left elbow', 'sensor mat', 'call bell', 'Paramedics attended', 'X-ray', '07:52'],
  },
  {
    id: 'gp-letter',
    format: 'scan',
    fileName: 'scan0042.pdf',
    blocks: [
      { h: 'Heol Fawr Medical Practice' },
      { p: '22 High Street, Cowbridge, CF71 7AG · Tel 01446 772 800' },
      { p: 'Re: Mr Kenneth Bowen, DOB 30/06/1944, NHS No 611 969 2495' },
      { p: '4 Station Terrace, Llantwit Major, CF61 1ST' },
      {
        p: 'Dear colleague, I saw Mr Bowen today with his wife, Glenys. His COPD has been stable and his inhaler technique is good. He is now using oxygen at night only. Please encourage him to keep up the breathing exercises taught by the respiratory nurse, Sarah Lewis.',
      },
      { p: 'He would benefit from support with shopping and a daily welfare check.' },
      { p: 'Yours sincerely, Dr Helen Parry' },
    ],
    remove: [
      ['Heol Fawr Medical Practice', 'ORGANISATION'],
      ['22 High Street', 'ADDRESS'],
      ['CF71 7AG', 'ADDRESS'],
      ['01446 772 800', 'PHONE'],
      ['Kenneth Bowen', 'PERSON'],
      ['30/06/1944', 'DATE_OF_BIRTH'],
      ['611 969 2495', 'ID'],
      ['4 Station Terrace', 'ADDRESS'],
      ['Llantwit Major', 'PLACE'],
      ['CF61 1ST', 'ADDRESS'],
      ['Mr Bowen', 'PERSON'],
      ['Glenys', 'PERSON'],
      ['Sarah Lewis', 'PERSON'],
      ['Helen Parry', 'PERSON'],
    ],
    keep: ['COPD', 'inhaler technique', 'oxygen at night', 'breathing exercises', 'welfare check'],
  },
  {
    id: 'assessment-photo',
    format: 'photo',
    fileName: 'IMG_4471.jpg',
    blocks: [
      { h: 'Initial assessment' },
      {
        table: [
          ['Client', 'Beryl Thomas'],
          ['Address', 'Flat 3, 18 Windsor Road, Penarth CF64 1JH'],
          ['Phone', '029 2070 3344'],
          ['NHS number', '749 467 7860'],
          ['Assessed by', 'Leanne Price'],
        ],
      },
      {
        p: 'Beryl has macular degeneration and cannot read post. She would like help with letters and a weekly shop at Tesco.',
      },
    ],
    remove: [
      ['Beryl Thomas', 'PERSON'],
      ['Beryl', 'PERSON'],
      ['18 Windsor Road', 'ADDRESS'],
      ['CF64 1JH', 'ADDRESS'],
      ['029 2070 3344', 'PHONE'],
      ['749 467 7860', 'ID'],
      ['Leanne Price', 'PERSON'],
    ],
    keep: ['macular degeneration', 'weekly shop', 'Initial assessment'],
  },
  {
    id: 'daily-notes',
    format: 'docx',
    fileName: 'Visit notes w38.docx',
    author: 'Chloe Davies',
    blocks: [
      { h: 'Visit notes, week 38' },
      {
        p: 'Mon 08:10 (Chloe): Stan was up and dressed. Took his tablets with breakfast. Said Denise is coming at the weekend.',
      },
      {
        p: 'Mon 18:30 (Jamie B): Stanley had eaten half his tea. A bit breathless on the stairs. Buster (the dog) had been walked by the neighbour, Mrs Okafor.',
      },
      {
        p: 'Tue 08:05 (Chloe): Stan was confused about the day. Rang his daughter Denise Hale on 07700 900 456, who said this happens when his water tablets are late.',
      },
      {
        p: 'Tue 18:40 (Jamie B): Better tonight. Watched the Cardiff City match. Mr Hale asked for his next appointment at Barry Hospital to be written on the calendar.',
      },
      { p: 'Wed 08:00 (Priti): All fine. Skin intact. Stan says hello to Chloe.' },
    ],
    remove: [
      ['Chloe', 'PERSON'],
      ['Stan', 'PERSON'],
      ['Stanley', 'PERSON'],
      ['Denise', 'PERSON'],
      ['Denise Hale', 'PERSON'],
      ['Mr Hale', 'PERSON'],
      ['Jamie B', 'PERSON'],
      ['Buster', 'OTHER'],
      ['Mrs Okafor', 'PERSON'],
      ['07700 900 456', 'PHONE'],
      ['Priti', 'PERSON'],
      ['Barry Hospital', 'ORGANISATION'],
    ],
    keep: ['Took his tablets', 'breathless on the stairs', 'water tablets', 'Skin intact', 'daughter'],
  },
  {
    id: 'discharge-summary',
    format: 'pdf',
    fileName: 'discharge_summary.pdf',
    blocks: [
      { h: 'Discharge summary' },
      {
        p: 'Patient: HUGHES, Elizabeth Ann   Hospital no: K1234567   NHS: 425 923 5788   DOB: 5th August 1936',
      },
      { p: 'Ward: Ward 12 (Care of the Elderly), University Hospital Llandough   Consultant: Dr S. Mahmood' },
      {
        p: 'Admitted with a urinary tract infection and delirium. Treated with IV antibiotics, now completed. Delirium resolved. Mobilising with a Zimmer frame and one carer.',
      },
      {
        p: 'Discharge address: 29 Clive Place, Penarth, CF64 1AU. Lives with husband Derek, who has early Parkinson’s.',
      },
      {
        p: 'Follow-up: District nurse (Nurse Owens) to review pressure areas. Mrs Hughes to see her GP in two weeks.',
      },
    ],
    remove: [
      ['HUGHES, Elizabeth Ann', 'PERSON'],
      ['K1234567', 'ID'],
      ['425 923 5788', 'ID'],
      ['5th August 1936', 'DATE_OF_BIRTH'],
      ['Dr S. Mahmood', 'PERSON'],
      ['29 Clive Place', 'ADDRESS'],
      ['CF64 1AU', 'ADDRESS'],
      ['Derek', 'PERSON'],
      ['Nurse Owens', 'PERSON'],
      ['Mrs Hughes', 'PERSON'],
    ],
    keep: ['urinary tract infection', 'IV antibiotics', 'Zimmer frame', 'pressure areas', 'Parkinson'],
  },
  {
    id: 'family-email',
    format: 'docx',
    fileName: 'Email from family.docx',
    blocks: [
      { p: 'From: Lisa Moreno <lisa.moreno@example.co.uk>' },
      { p: 'To: office@example-care.co.uk' },
      { p: 'Subject: Dad (Frank Moreno) - Christmas arrangements' },
      {
        p: 'Hi Jo, just to let you know that Dad will be staying with us in Cheltenham from 23 to 28 December, so please cancel his calls for those days. My brother Paul will drive him back to Sully on the 28th. Dad’s mobile is 07911 123 456 if the carers need him. His neighbour Val has a spare key. Thanks, Lisa (07700 900 789)',
      },
    ],
    remove: [
      ['Lisa Moreno', 'PERSON'],
      ['lisa.moreno@example.co.uk', 'EMAIL'],
      ['Frank Moreno', 'PERSON'],
      ['Jo', 'PERSON'],
      ['Cheltenham', 'PLACE'],
      ['Paul', 'PERSON'],
      ['Sully', 'PLACE'],
      ['07911 123 456', 'PHONE'],
      ['Val', 'PERSON'],
      ['Lisa', 'PERSON'],
      ['07700 900 789', 'PHONE'],
    ],
    keep: ['Christmas arrangements', 'cancel his calls', 'spare key'],
  },
  {
    id: 'safeguarding',
    format: 'docx',
    fileName: 'Safeguarding concern.docx',
    blocks: [
      { h: 'Safeguarding concern' },
      {
        p: 'Carer Ffion Jenkins reported that Mr Idris Rowlands (Iddy) had no food in the house on Thursday and said his grandson Kyle "looks after his money". Mr Rowlands is the former headmaster of Ysgol y Castell and is well known in St Athan.',
      },
      {
        p: 'Kyle Rowlands, 24, drives a silver Corsa, registration CY19 KLM. Neighbours have seen him collecting Mr Rowlands’s bank card from the house at 3 Maes Glas.',
      },
      { p: 'Referred to the local authority safeguarding team on 24/09/2026. Reference SG-55821.' },
    ],
    remove: [
      ['Ffion Jenkins', 'PERSON'],
      ['Idris Rowlands', 'PERSON'],
      ['Iddy', 'PERSON'],
      ['Kyle', 'PERSON'],
      ['Mr Rowlands', 'PERSON'],
      ['Ysgol y Castell', 'ORGANISATION'],
      ['St Athan', 'PLACE'],
      ['Kyle Rowlands', 'PERSON'],
      ['CY19 KLM', 'OTHER'],
      ['3 Maes Glas', 'ADDRESS'],
      ['SG-55821', 'ID'],
    ],
    keep: ['no food in the house', 'bank card', 'safeguarding team', 'grandson'],
  },
  {
    id: 'policy-no-pii',
    format: 'pdf',
    fileName: 'Medication policy.pdf',
    blocks: [
      { h: 'Medication support policy' },
      {
        p: 'This policy explains how care workers support people with their medicines at home. It follows NICE guideline NG67 and the Care Inspectorate Wales guidance on managing medicines.',
      },
      {
        p: 'There are three levels of support: prompting, assisting and administering. The level for each person is recorded in their care plan and on the medication administration record (MAR chart).',
      },
      {
        p: 'Care workers must not crush tablets unless a pharmacist has confirmed it is safe. Controlled drugs require two signatures. Any error must be reported to the office on the same day.',
      },
      { p: 'Review date: March 2027. Approved by the Registered Manager.' },
    ],
    remove: [],
    keep: [
      'NICE guideline NG67',
      'Care Inspectorate Wales',
      'MAR chart',
      'Controlled drugs',
      'Registered Manager',
      'March 2027',
      'prompting, assisting and administering',
    ],
  },
];
