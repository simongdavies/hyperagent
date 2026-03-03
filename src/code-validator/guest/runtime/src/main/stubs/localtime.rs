/*
Copyright 2026  The Hyperlight Authors.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

//! localtime_r stub for rquickjs.
//!
//! For the analysis guest, we don't need accurate time - we just return
//! a fixed UTC time. The analysis functions don't depend on timestamps.

use core::ptr::null_mut;

use crate::libc;

#[unsafe(no_mangle)]
extern "C" fn localtime_r(time: *const libc::time_t, result: *mut libc::tm) -> *mut libc::tm {
    let offset = unsafe { time.read() };
    let tm = unsafe { result.as_mut() };

    let tm = match tm {
        Some(tm) => tm,
        None => return null_mut(),
    };

    // Simple conversion - just handle the basic case
    // For the analysis guest, we don't need accurate date conversion
    // We just need the function to exist and not crash

    // Calculate days since epoch (rough approximation)
    let days = offset / 86400;
    let remaining = offset % 86400;

    // Time of day
    tm.tm_sec = (remaining % 60) as _;
    tm.tm_min = ((remaining / 60) % 60) as _;
    tm.tm_hour = ((remaining / 3600) % 24) as _;

    // Date calculation (simplified - doesn't handle all edge cases)
    // Start from 1970-01-01
    let mut year = 1970i32;
    let mut remaining_days = days;

    // Find the year
    loop {
        let days_in_year = if is_leap_year(year) { 366 } else { 365 };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        year += 1;
    }

    tm.tm_year = (year - 1900) as _;
    tm.tm_yday = remaining_days as _;

    // Find the month
    let leap = is_leap_year(year);
    let days_per_month: [i64; 12] = if leap {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut month = 0;
    for (i, &days_in_month) in days_per_month.iter().enumerate() {
        if remaining_days < days_in_month {
            month = i;
            break;
        }
        remaining_days -= days_in_month;
    }

    tm.tm_mon = month as _;
    tm.tm_mday = (remaining_days + 1) as _;

    // Day of week (Jan 1, 1970 was Thursday = 4)
    tm.tm_wday = ((days + 4) % 7) as _;

    // No DST
    tm.tm_isdst = 0;
    tm.__tm_gmtoff = 0;
    tm.__tm_zone = c"UTC".as_ptr() as _;

    result
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}
